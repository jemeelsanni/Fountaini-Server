import { Prisma, type EnrollmentStatus, type StudentStatus } from "../../../generated/prisma/index.js";
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
import type {
  BulkUpdateStudentStatusBody,
  CreateEnrollmentBody,
  CreateStudentBody,
  UpdateStudentBody,
} from "./students.schemas.js";

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

/// GRADUATED/WITHDRAWN unambiguously mean "this student's relationship with
/// the school just ended" — mapped 1:1 onto the matching EnrollmentStatus
/// value. INACTIVE and ACTIVE are deliberately absent: nothing in this
/// codebase defines what INACTIVE means beyond "not currently ACTIVE" (never
/// read anywhere before this pass, no seed usage, no enum comment) — closing
/// an enrollment on an ambiguous status is the kind of silent, hard-to-
/// reverse side effect this avoids on purpose. Setting status back to ACTIVE
/// never reopens a closed enrollment either: re-enrollment is
/// POST /api/students/:id/enrollments, a deliberate action that picks a
/// specific class, not a side effect of a status flip.
const ENROLLMENT_CLOSING_STATUS: Partial<Record<StudentStatus, EnrollmentStatus>> = {
  GRADUATED: "GRADUATED",
  WITHDRAWN: "WITHDRAWN",
};

/// Closes EVERY currently-ACTIVE enrollment this student holds, not just the
/// current session's — a student can, today, accumulate stale-ACTIVE
/// enrollments from past sessions (nothing has ever closed one; see the
/// report), and graduating/withdrawing is a genuine "this is over" signal
/// that should clear all of them. Every consumer of enrollment.status scopes
/// its own query by academicSessionId anyway, so this is a safe cleanup, not
/// a behavior change for anything else.
async function closeActiveEnrollments(
  tx: Prisma.TransactionClient,
  studentId: string,
  status: EnrollmentStatus,
  actorUserId: string,
): Promise<void> {
  await tx.enrollment.updateMany({
    where: { studentId, status: "ACTIVE" },
    data: { status, closedAt: new Date(), closedByUserId: actorUserId },
  });
}

export async function updateStudent(id: string, input: UpdateStudentBody, actorUserId: string) {
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  const { admissionNumber, ...rest } = input;
  const closingStatus = input.status ? ENROLLMENT_CLOSING_STATUS[input.status] : undefined;

  try {
    return await prisma.$transaction(async (tx) => {
      const data = admissionNumber !== undefined ? { ...rest, admissionNumber } : rest;
      const updated = await tx.student.update({ where: { id }, data });
      // admissionNumber changed — the linked User's loginId must change with
      // it, in the same transaction, or the student's ID card and their
      // login silently diverge.
      if (admissionNumber !== undefined && updated.userId) {
        await tx.user.update({ where: { id: updated.userId }, data: { loginId: admissionNumber } });
      }
      if (closingStatus) {
        await closeActiveEnrollments(tx, id, closingStatus, actorUserId);
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

/// Partial success, not all-or-nothing — one bad id (or one unexpected
/// per-student failure) must not block a graduation run for a whole class.
/// Each id gets its own transaction (student status + enrollment-closing
/// together, atomic per student) rather than one transaction for the whole
/// batch, which is what actually makes partial success possible: a single
/// shared transaction would roll back every success alongside the one
/// failure. Sequential, not Promise.all — this is a bulk admin operation
/// capped at a few hundred ids, not a hot path, and running up to 500
/// transactions concurrently risks exhausting the connection pool for no
/// real benefit here.
export async function bulkUpdateStudentStatus(
  input: BulkUpdateStudentStatusBody,
  actorUserId: string,
): Promise<{ updated: string[]; failed: { id: string; message: string }[] }> {
  const existing = await prisma.student.findMany({
    where: { id: { in: input.ids } },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((s) => s.id));
  const closingStatus = ENROLLMENT_CLOSING_STATUS[input.status];

  const updated: string[] = [];
  const failed: { id: string; message: string }[] = [];

  for (const id of input.ids) {
    if (!existingIds.has(id)) {
      failed.push({ id, message: "Student not found" });
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.student.update({ where: { id }, data: { status: input.status } });
        if (closingStatus) {
          await closeActiveEnrollments(tx, id, closingStatus, actorUserId);
        }
      });
      updated.push(id);
    } catch (err) {
      logger.error({ err, id }, "Failed to update student status in bulk request");
      failed.push({ id, message: "Unexpected error updating this student" });
    }
  }

  return { updated, failed };
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
