import { Prisma } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import {
  generateAdmissionNumber,
  getCurrentSessionStartYear,
  registerAdmissionNumberOverride,
} from "../identifiers/identifiers.service.js";
import { createNotification } from "../notifications/notifications.service.js";
import type { CreateEnrollmentBody, CreateStudentBody, UpdateStudentBody } from "./students.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// The student's linked parent to notify/contact when the student has no
/// email of their own — the flagged isPrimaryContact link if one exists
/// (see StudentParent's own comment: at most one, enforced by a partial
/// unique index), otherwise the earliest-linked parent. Returns null if the
/// student has no linked parents at all yet. Shared by credential delivery
/// (below) and password-reset destination resolution (auth.service.ts).
export async function resolvePrimaryContactParent(studentId: string) {
  const links = await prisma.studentParent.findMany({
    where: { studentId },
    include: { parent: { include: { user: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (links.length === 0) {
    return null;
  }
  return links.find((l) => l.isPrimaryContact) ?? links[0]!;
}

/// Sends the CREDENTIALS_ISSUED notification and reports whether a
/// destination existed to send it to — the caller uses that to decide
/// whether the temporary password must be returned in the response instead
/// (see Section C: an unrecoverable account is not acceptable). The actual
/// send is fire-and-forget (mirrors notifyPaymentConfirmed in
/// fees.service.ts) — a slow or failing notification must not hold up the
/// response, but "is there anywhere to send this" is resolved and awaited
/// first, since the response shape genuinely depends on it.
async function deliverStudentCredentials(
  student: { id: string; admissionNumber: string; firstName: string; lastName: string },
  ownUserId: string,
  ownEmail: string | null,
  temporaryPassword: string,
): Promise<boolean> {
  if (ownEmail) {
    createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: ownUserId,
      subject: "Your school portal login",
      body:
        `Your login ID is ${student.admissionNumber}. Temporary password: ${temporaryPassword}. ` +
        `You'll be asked to change it the first time you sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: "Student",
      relatedEntityId: student.id,
    }).catch((err: unknown) => {
      logger.error({ err }, "Failed to send student credential notification (own email)");
    });
    return true;
  }

  const contact = await resolvePrimaryContactParent(student.id);
  const parentEmail = contact?.parent.user.email;
  if (!contact || !parentEmail) {
    return false;
  }

  createNotification({
    type: "CREDENTIALS_ISSUED",
    recipientUserId: contact.parent.userId,
    subject: `Login credentials for ${student.firstName} ${student.lastName}`,
    body:
      `A school portal login has been created for ${student.firstName} ${student.lastName} ` +
      `(${student.admissionNumber}). Temporary password: ${temporaryPassword}. ` +
      `They'll be asked to change it the first time they sign in.`,
    channels: ["EMAIL"],
    relatedEntityType: "Student",
    relatedEntityId: student.id,
  }).catch((err: unknown) => {
    logger.error({ err }, "Failed to send student credential notification (parent)");
  });
  return true;
}

/// Atomic: generates (or registers an override for) the admission number,
/// optionally creates the User + issues a login, and creates the Student
/// row, all in one transaction — see the report on why the old two-step
/// POST /api/users -> POST /api/students flow can't survive a loginId
/// derived from a number that doesn't exist until this row is written.
/// issueLogin at create time can only deliver to the student's OWN email
/// (input.email) — a parent can't be linked yet, since studentId doesn't
/// exist before this returns. The common "student has no email of their
/// own" case is expected to issue the login later via
/// PATCH /api/students/:id { issueLogin: true }, after a parent is linked.
export async function createStudent(input: CreateStudentBody) {
  const { student, temporaryPassword } = await prisma.$transaction(async (tx) => {
    let admissionNumber: string;
    if (input.admissionNumber) {
      // A legacy import may be from any past year — registering it never
      // needs "a session is current right now" to be true.
      admissionNumber = input.admissionNumber;
      await registerAdmissionNumberOverride(tx, admissionNumber);
    } else {
      const year = await getCurrentSessionStartYear(tx);
      admissionNumber = await generateAdmissionNumber(tx, year);
    }

    let userId: string | undefined;
    let issuedPassword: string | undefined;
    if (input.issueLogin) {
      issuedPassword = generateTemporaryPassword();
      const user = await tx.user.create({
        data: {
          loginId: admissionNumber,
          email: input.email ?? null,
          passwordHash: await hashPassword(issuedPassword),
          mustChangePassword: true,
          roles: { create: [{ role: "STUDENT" }] },
        },
      });
      userId = user.id;
    }

    let created;
    try {
      created = await tx.student.create({
        data: {
          admissionNumber,
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames,
          dateOfBirth: input.dateOfBirth,
          gender: input.gender,
          admissionDate: input.admissionDate,
          userId,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw AppError.conflict("A student with this admission number already exists");
      }
      throw err;
    }

    return { student: created, temporaryPassword: issuedPassword };
  });

  if (!student.userId || !temporaryPassword) {
    return student;
  }

  const delivered = await deliverStudentCredentials(student, student.userId, input.email ?? null, temporaryPassword);
  return delivered ? student : { ...student, temporaryPassword };
}

export function listStudents() {
  return prisma.student.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

export async function getStudentById(id: string) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }
  return student;
}

/// Replaces Fix 6's userId-attach path: rather than accepting an arbitrary
/// pre-existing user id, this creates a brand-new User with loginId derived
/// from the student's OWN (already-known) admissionNumber — the only way
/// this can now be consistent, since a login-less student was never given
/// a loginId-worthy identifier to attach to a stray user in the first
/// place. Race-safe via the same conditional-claim shape the old path used
/// (see docs/concurrency.md): if two concurrent issueLogin calls race for
/// the same student, only one wins the updateMany, and the transaction
/// rolls back the loser's freshly-created User with it.
async function issueLoginForStudent(id: string, email: string | undefined) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }
  // Cheap pre-check to skip the wasted work in the common (non-racing)
  // case — NOT what makes this race-safe (see the catch below for that).
  if (student.userId) {
    throw AppError.conflict("This student already has a linked user account");
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          loginId: student.admissionNumber,
          email: email ?? null,
          passwordHash,
          mustChangePassword: true,
          roles: { create: [{ role: "STUDENT" }] },
        },
      });

      const { count } = await tx.student.updateMany({
        where: { id, userId: null },
        data: { userId: user.id },
      });
      if (count === 0) {
        throw AppError.conflict("This student already has a linked user account");
      }
      return tx.student.findUniqueOrThrow({ where: { id } });
    });
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    // Two concurrent issueLogin calls for the same never-logged-in-yet
    // student can both pass the pre-check above (both see userId: null)
    // and both attempt to create a User with the same loginId — this
    // student's admissionNumber hasn't changed between them — so the
    // loser hits this unique constraint instead of ever reaching the
    // updateMany claim above. Same clean 409 either way; see
    // docs/concurrency.md.
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This student already has a linked user account");
    }
    throw err;
  }

  const delivered = await deliverStudentCredentials(updated, updated.userId!, email ?? null, temporaryPassword);
  return delivered ? updated : { ...updated, temporaryPassword };
}

export async function updateStudent(id: string, input: UpdateStudentBody) {
  if (input.issueLogin) {
    return issueLoginForStudent(id, input.email);
  }

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  const { admissionNumber, issueLogin: _issueLogin, email: _email, ...rest } = input;

  try {
    if (admissionNumber === undefined) {
      return await prisma.student.update({ where: { id }, data: rest });
    }

    // admissionNumber changed — the linked User's loginId must change with
    // it, in the same transaction, or the student's ID card and their
    // login silently diverge.
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.student.update({ where: { id }, data: { ...rest, admissionNumber } });
      if (updated.userId) {
        await tx.user.update({ where: { id: updated.userId }, data: { loginId: admissionNumber } });
      }
      return updated;
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A student with this admission number already exists");
    }
    throw err;
  }
}

export async function createEnrollment(studentId: string, input: CreateEnrollmentBody) {
  const [student, klass, session] = await Promise.all([
    prisma.student.findUnique({ where: { id: studentId } }),
    prisma.class.findUnique({ where: { id: input.classId } }),
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId } }),
  ]);

  if (!student) throw AppError.notFound("Student not found");
  if (!klass) throw AppError.notFound("Class not found");
  if (!session) throw AppError.notFound("Academic session not found");

  try {
    return await prisma.enrollment.create({
      data: { studentId, classId: input.classId, academicSessionId: input.academicSessionId },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This student is already enrolled for this academic session");
    }
    throw err;
  }
}

export function listParentsForStudent(studentId: string) {
  return prisma.studentParent.findMany({
    where: { studentId },
    include: { parent: true },
  });
}

export function listEnrollmentsForStudent(studentId: string) {
  return prisma.enrollment.findMany({
    where: { studentId },
    include: { class: true, academicSession: true },
    orderBy: { createdAt: "desc" },
  });
}
