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
import { createNotification, suppressCredentialNotifications } from "../notifications/notifications.service.js";
import type { CreateEnrollmentBody, CreateStudentBody, UpdateStudentBody } from "./students.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/// The student's linked parent to notify/contact when the student has no
/// email of their own — the flagged isPrimaryContact link if one exists
/// (see StudentParent's own comment: at most one, enforced by a partial
/// unique index), otherwise the earliest-linked parent. Returns null if the
/// student has no linked parents at all. Shared by credential issuance
/// (parents.service.ts's linkChild), reissueCredentials below, and
/// password-reset destination resolution (auth.service.ts).
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

/// Generates a student's FIRST login, atomically, and notifies the given
/// parent — called from parents.service.ts's linkChild exactly when a link
/// is created with isPrimaryContact: true. Self-guarding, not just
/// race-safe: does nothing at all if the student already has a userId
/// (checked fresh here, not trusted from the caller), so linkChild can call
/// this unconditionally on every primary-contact link without separately
/// tracking "is this the first one" itself — "first" is exactly "no userId
/// yet," which this function is the sole authority on. A student's own
/// email is never involved: delivery is always to this parent now.
///
/// A failure here must never undo an otherwise-successful parent link, so
/// this is called after the link already committed, and errors are caught
/// and logged rather than propagated — matching this codebase's existing
/// posture (see fees.service.ts's notifyPaymentConfirmed) that a slow or
/// failing notification/side-effect must not turn an otherwise-successful
/// mutation into a failed request.
export async function issueFirstLoginForStudent(
  studentId: string,
  recipientParent: { userId: string; user: { email: string | null } },
): Promise<void> {
  try {
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student || student.userId) {
      return;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    // Returns null if the race was lost (some other concurrent call
    // already issued this student's first login) — the transaction rolls
    // back this attempt's freshly-created (now-orphaned) User with it. A
    // return value, not a thrown sentinel: this is an ordinary, expected
    // outcome under concurrency, not an error condition.
    const issued = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          loginId: student.admissionNumber,
          email: null,
          passwordHash,
          mustChangePassword: true,
          roles: { create: [{ role: "STUDENT" }] },
        },
      });

      const { count } = await tx.student.updateMany({
        where: { id: studentId, userId: null },
        data: { userId: user.id },
      });
      return count > 0;
    });
    if (!issued) {
      return;
    }

    if (!recipientParent.user.email) {
      logger.error(
        { studentId },
        "Primary-contact parent has no email on file — credentials generated but not delivered",
      );
      return;
    }

    if (suppressCredentialNotifications) {
      return;
    }

    await createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: recipientParent.userId,
      subject: `Login credentials for ${student.firstName} ${student.lastName}`,
      body:
        `A school portal login has been created for ${student.firstName} ${student.lastName} ` +
        `(${student.admissionNumber}). Temporary password: ${temporaryPassword}. ` +
        `They'll be asked to change it the first time they sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: "Student",
      relatedEntityId: studentId,
    });
  } catch (err) {
    logger.error({ err, studentId }, "Failed to issue first login for student");
  }
}

/// The recovery path for a student who already has a login but has since
/// become undeliverable — every linked parent was unlinked, or the
/// original one lost the email, or a different parent has since become
/// primary (relinking after an unlink is deliberately silent — see the
/// report — so this is also how a NEW primary contact actually learns the
/// password). Always generates a fresh password (never admin-chosen, same
/// as every other credential path in this system) and always resets
/// mustChangePassword to true and revokes existing sessions — a freshly
/// issued credential must not coexist with sessions built on whatever
/// existed before it, the same posture changePassword()/resetPassword()
/// already take.
///
/// Two distinct failure states, both real and both worth a clear message:
/// no login exists yet at all (link a primary-contact parent first — that's
/// what creates one), and a login exists but there is nowhere left to
/// deliver to. The second is NOT a hard error: rather than blocking the
/// admin action that produced it (unlinking a student's last parent stays
/// legal — see the report), this endpoint lets an admin recover a student
/// in that state by generating a fresh password and returning it once in
/// the response, exactly like a paper hand-over.
export async function reissueCredentialsForStudent(studentId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }
  if (!student.userId) {
    throw AppError.conflict(
      "This student has no login yet — link a primary-contact parent to issue one first",
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: student.userId },
      data: { passwordHash, mustChangePassword: true },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: student.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  const contact = await resolvePrimaryContactParent(studentId);
  const parentEmail = contact?.parent.user.email;
  if (!contact || !parentEmail) {
    return { ...student, temporaryPassword };
  }

  if (suppressCredentialNotifications) {
    return student;
  }

  await createNotification({
    type: "CREDENTIALS_ISSUED",
    recipientUserId: contact.parent.userId,
    subject: `Login credentials for ${student.firstName} ${student.lastName}`,
    body:
      `A new temporary password has been issued for ${student.firstName} ${student.lastName}'s ` +
      `school portal login (${student.admissionNumber}): ${temporaryPassword}. ` +
      `They'll be asked to change it the first time they sign in.`,
    channels: ["EMAIL"],
    relatedEntityType: "Student",
    relatedEntityId: studentId,
  });

  return student;
}

export async function createStudent(input: CreateStudentBody) {
  return prisma.$transaction(async (tx) => {
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

    try {
      return await tx.student.create({
        data: {
          admissionNumber,
          firstName: input.firstName,
          lastName: input.lastName,
          otherNames: input.otherNames,
          dateOfBirth: input.dateOfBirth,
          gender: input.gender,
          admissionDate: input.admissionDate,
        },
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw AppError.conflict("A student with this admission number already exists");
      }
      throw err;
    }
  });
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

export async function updateStudent(id: string, input: UpdateStudentBody) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  const { admissionNumber, ...rest } = input;

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
