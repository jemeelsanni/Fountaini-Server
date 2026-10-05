import { Prisma, type EnrollmentStatus, type Role, type StudentStatus } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { writeAuditLog } from "../audit/audit.service.js";
import {
  generateAdmissionNumber,
  getCurrentSessionStartYear,
  registerAdmissionNumberOverride,
} from "../identifiers/identifiers.service.js";
import { createNotification, suppressCredentialNotifications } from "../notifications/notifications.service.js";
import { reissueCredentialsForUser } from "../users/users.service.js";
import type {
  BulkUpdateStudentStatusBody,
  CreateEnrollmentBody,
  CreateStudentBody,
  SearchStudentsQuery,
  UpdateStudentBody,
} from "./students.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
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
      sensitive: true,
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
///
/// This student-specific framing (the 404/409 messages, and splicing the
/// returned temporaryPassword onto the full student record rather than a
/// bare user id) is the one thing that stays here — the actual credential
/// generation, delivery, and student-vs-own-email destination resolution
/// is the SAME shared implementation GET /api/users/:id/reissue-credentials
/// calls (see reissueCredentialsForUser, users.service.ts), not a second
/// copy of it.
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

  const result = await reissueCredentialsForUser(student.userId);
  return result.temporaryPassword ? { ...student, temporaryPassword: result.temporaryPassword } : student;
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

export interface StudentSearchResult {
  id: string;
  admissionNumber: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  status: StudentStatus;
  className: string | null;
}

interface RawStudentSearchRow {
  id: string;
  admissionNumber: string;
  firstName: string;
  lastName: string;
  otherNames: string | null;
  status: StudentStatus;
  gradeName: string | null;
  arm: string | null;
}

// Postgres's default LIKE/ILIKE escape character is already backslash, so
// doubling a literal backslash and prefixing % and _ here is enough to make
// a search term that happens to contain one of them match literally rather
// than act as a wildcard — no explicit ESCAPE clause needed below.
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/// Backs the student picker on screens like the bursar's Invoices page
/// (POST /api/fee-obligations/:id/payments needs a studentId the bursar has
/// no other way to find — GET /api/students is ADMIN-only and returns every
/// field on every student, neither of which this route should do). Minimal
/// projection only: id, admissionNumber, name fields, status, and
/// current-session class name — deliberately never dateOfBirth, gender, or
/// anything from a parent, none of which a picker needs.
///
/// All statuses match by default, including WITHDRAWN and GRADUATED — a
/// student who left still owing fees must stay findable by whoever's
/// chasing that balance; `status` narrows only when explicitly given.
///
/// Relevance-then-name ordering, computed as a three-tier rank in SQL:
///   0. exact (case-insensitive) match on admissionNumber, firstName or
///      lastName
///   1. prefix match on the same three fields
///   2. contains-anywhere match — the fallback, and the only tier an
///      otherNames-only hit or a mid-string admission-number fragment
///      (e.g. "001") ever lands in
/// Ties within a tier break by lastName, firstName, matching listStudents().
///
/// Class name is resolved via the student's CURRENT-session, ACTIVE
/// Enrollment (LEFT JOIN — a withdrawn/graduated student, or one not
/// enrolled this session, correctly comes back with className: null rather
/// than a stale class from some past session).
export async function searchStudents(query: SearchStudentsQuery): Promise<StudentSearchResult[]> {
  const escaped = escapeLikePattern(query.q);
  const containsPattern = `%${escaped}%`;
  const prefixPattern = `${escaped}%`;

  const statusClause = query.status
    ? Prisma.sql`AND s.status = ${query.status}::"StudentStatus"`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<RawStudentSearchRow[]>`
    SELECT
      s.id, s."admissionNumber", s."firstName", s."lastName", s."otherNames", s.status,
      cls."gradeName", cls.arm
    FROM "Student" s
    LEFT JOIN "Enrollment" e
      ON e."studentId" = s.id
     AND e.status = 'ACTIVE'
     AND e."academicSessionId" = (SELECT id FROM "AcademicSession" WHERE "isCurrent" = true LIMIT 1)
    LEFT JOIN "Class" cls ON cls.id = e."classId"
    WHERE (
      s."admissionNumber" ILIKE ${containsPattern}
      OR s."firstName" ILIKE ${containsPattern}
      OR s."lastName" ILIKE ${containsPattern}
      OR s."otherNames" ILIKE ${containsPattern}
    )
    ${statusClause}
    ORDER BY
      CASE
        WHEN LOWER(s."admissionNumber") = LOWER(${query.q})
          OR LOWER(s."firstName") = LOWER(${query.q})
          OR LOWER(s."lastName") = LOWER(${query.q})
          THEN 0
        WHEN s."admissionNumber" ILIKE ${prefixPattern}
          OR s."firstName" ILIKE ${prefixPattern}
          OR s."lastName" ILIKE ${prefixPattern}
          THEN 1
        ELSE 2
      END,
      s."lastName" ASC,
      s."firstName" ASC
    LIMIT ${query.limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    admissionNumber: row.admissionNumber,
    firstName: row.firstName,
    lastName: row.lastName,
    otherNames: row.otherNames,
    status: row.status,
    className: row.gradeName ? `${row.gradeName}${row.arm ? ` ${row.arm}` : ""}` : null,
  }));
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
/// Explicit per-student audit rows, not the generic auditMutation()
/// middleware on this route — same shape problem RESULT_RANKED had, and
/// the same fix. auditMutation writes exactly one row per REQUEST, keyed
/// by req.params.id or the response body's own id; this route has no
/// single id of either kind (:id isn't in the path at all, and the
/// response is a { updated, failed } summary, not one entity) — the
/// generic write would land as entityId: "unknown", afterData the summary
/// rather than any one student's data, and a History panel keyed by
/// student id would never find it. Fire-and-forget per row, same posture
/// as the write auditMutation itself does: an audit write must never delay
/// or fail an otherwise-successful update, least of all one row's failure
/// blocking the rest of the batch's audit trail.
export async function bulkUpdateStudentStatus(
  input: BulkUpdateStudentStatusBody,
  actorUserId: string,
  actorRoles: Role[],
): Promise<{ updated: string[]; failed: { id: string; message: string }[] }> {
  const existing = await prisma.student.findMany({ where: { id: { in: input.ids } } });
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const closingStatus = ENROLLMENT_CLOSING_STATUS[input.status];

  const updated: string[] = [];
  const failed: { id: string; message: string }[] = [];

  for (const id of input.ids) {
    const before = existingById.get(id);
    if (!before) {
      failed.push({ id, message: "Student not found" });
      continue;
    }
    try {
      const after = await prisma.$transaction(async (tx) => {
        const result = await tx.student.update({ where: { id }, data: { status: input.status } });
        if (closingStatus) {
          await closeActiveEnrollments(tx, id, closingStatus, actorUserId);
        }
        return result;
      });
      updated.push(id);

      fireAndForget(
        writeAuditLog({
          actorUserId,
          actorRoles,
          action: "STUDENT_STATUS_BULK_UPDATED",
          entityType: "Student",
          entityId: id,
          beforeData: JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue,
          afterData: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue,
        }),
        (err) => logger.error({ err, id }, "Failed to write STUDENT_STATUS_BULK_UPDATED audit log"),
      );
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

/// In-place classId edit on the student's current-session enrollment — not
/// close-old-open-new. The school confirmed a same-arm move (e.g. JSS1 A to
/// JSS1 B) keeps everything: scores/SubjectResults stay attached to
/// whichever assignment actually produced them (never repointed — that
/// would misattribute the work to a teacher who didn't do it), and
/// attendance stays attached to whichever sessions it was actually taken
/// in. Both survive this edit correctly ONLY because computeResultsForClass
/// and computeAttendanceSnapshot are now scoped by studentId, not by one
/// class — see their own comments (results.service.ts). @@unique([studentId,
/// academicSessionId]) never even comes into play: this updates the one
/// existing Enrollment row in place, so the (studentId, academicSessionId)
/// tuple is identical before and after.
///
/// Rejects a cross-grade-level move (400) rather than allowing it: JSS1 and
/// JSS2 have entirely separate ClassSubjectAssignment rows even for a
/// subject with the same name (@@unique([classId, subjectId,
/// academicSessionId])) — a grade-level change means the curriculum itself
/// changes, so blending a JSS1 SubjectResult into what reads as a JSS2
/// grade would average two different curricula into one meaningless
/// number. Grade changes are also a different kind of event in the first
/// place — normally a session boundary (promotion), already served by
/// POST /api/students/:id/enrollments (a fresh enrollment for a new
/// session) — not a mid-term correction this endpoint is for.
///
/// Deliberately no partial-term awareness: a Result already FINALIZED
/// before the move gets re-ranked against its new class's cohort the next
/// time anyone ranks that class, same as any other re-rank — consistent
/// with how position already works for every result, not something to
/// engineer around here. That's a fairness question for the school to
/// weigh, not a bug.
export async function transferStudent(studentId: string, newClassId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) {
    throw AppError.notFound("Student not found");
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: { studentId, status: "ACTIVE", academicSession: { isCurrent: true } },
    include: { class: true },
  });
  if (!enrollment) {
    throw AppError.badRequest(
      "This student has no active enrollment in the current academic session to transfer",
    );
  }

  const newClass = await prisma.class.findUnique({ where: { id: newClassId } });
  if (!newClass) {
    throw AppError.notFound("Class not found");
  }

  if (enrollment.class.gradeName !== newClass.gradeName) {
    throw AppError.badRequest(
      `${enrollment.class.gradeName} and ${newClass.gradeName} are different grade levels — this endpoint ` +
        "only moves a student between arms of the SAME grade level (e.g. JSS1 A to JSS1 B). A cross-grade " +
        "move (promotion, repeat, or a misclassification correction) needs its own, separately-considered " +
        "path — see POST /api/students/:id/enrollments.",
    );
  }

  return prisma.enrollment.update({ where: { id: enrollment.id }, data: { classId: newClassId } });
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
