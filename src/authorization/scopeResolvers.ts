import { prisma } from "../db/client.js";
import type { Principal } from "./types.js";

/// Shared by resolveStudentAccessLevel's TEACHER branch and
/// canReadStudentParents: "is this staff member currently assigned (via
/// ClassSubjectAssignment, scoped to the CURRENT academic session) to a
/// class this student is actively enrolled in." One DB round trip, one
/// place the assignment-lookup logic lives.
async function isTeacherAssignedToStudent(staffId: string, studentId: string): Promise<boolean> {
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId, status: "ACTIVE", academicSession: { isCurrent: true } },
    select: { classId: true, academicSessionId: true },
  });
  if (enrollments.length === 0) {
    return false;
  }
  const assignment = await prisma.classSubjectAssignment.findFirst({
    where: {
      teacherId: staffId,
      OR: enrollments.map((e) => ({ classId: e.classId, academicSessionId: e.academicSessionId })),
    },
    select: { id: true },
  });
  return assignment !== null;
}

/// Shared by canWriteClassTeacherComment and canReadClassResults: "is this
/// staff member the FORM teacher (ClassFormTeacher, not any subject
/// teacher) of this class for this academic session." Both resolvers reach
/// this from different inputs — one from a resultId, one from a bare
/// classId+termId — so the outer functions can't literally be the same
/// call, but the actual form-teacher check is one place.
async function isFormTeacherOfClass(
  staffId: string,
  classId: string,
  academicSessionId: string,
): Promise<boolean> {
  const formTeacher = await prisma.classFormTeacher.findUnique({
    where: { classId_academicSessionId: { classId, academicSessionId } },
    select: { teacherId: true },
  });
  return formTeacher?.teacherId === staffId;
}

/// Distinguishes not just WHETHER a principal may read a student's record
/// (see canReadStudent, which this backs) but the LEVEL of access: "FULL"
/// (any ADMIN, or a teacher currently assigned — via ClassSubjectAssignment,
/// scoped to the CURRENT academic session — to the class the student is
/// actively enrolled in this session) sees a student's records at every
/// lifecycle stage; "RESTRICTED" (the student themself, or a parent linked
/// via StudentParent) is meant for resources with a draft/in-progress phase
/// that shouldn't be visible until finalized (see
/// getResultForStudentTerm's status filter — the only caller of this
/// distinction today). `null` means no access at all.
///
/// A principal can hold more than one of these roles at once (a
/// staff-parent, say) for the SAME student — every applicable path is
/// checked, not just the first match, and FULL wins if any FULL-granting
/// path applies even when a RESTRICTED path also would (e.g. a staff-parent
/// whose own child happens to sit in their own assigned class). TEACHER is
/// checked last and returns immediately on a match so that case is never
/// masked by an earlier RESTRICTED match.
export async function resolveStudentAccessLevel(
  principal: Principal,
  studentId: string,
): Promise<"FULL" | "RESTRICTED" | null> {
  if (principal.roles.has("ADMIN")) {
    return "FULL";
  }

  let restricted = false;

  if (principal.roles.has("STUDENT") && principal.studentId === studentId) {
    restricted = true;
  }

  if (principal.roles.has("PARENT") && principal.parentId) {
    const link = await prisma.studentParent.findUnique({
      where: { studentId_parentId: { studentId, parentId: principal.parentId } },
      select: { id: true },
    });
    if (link !== null) {
      restricted = true;
    }
  }

  if (principal.roles.has("TEACHER") && principal.staffId) {
    if (await isTeacherAssignedToStudent(principal.staffId, studentId)) {
      return "FULL";
    }
  }

  return restricted ? "RESTRICTED" : null;
}

/// A student's record is readable by: any ADMIN; the student themself; a
/// parent linked via StudentParent; or a teacher currently assigned to the
/// class the student is actively enrolled in this session — i.e. either
/// access level resolveStudentAccessLevel can return.
export async function canReadStudent(principal: Principal, studentId: string): Promise<boolean> {
  return (await resolveStudentAccessLevel(principal, studentId)) !== null;
}

/// Narrower than canReadStudent: ADMIN, the assigned teacher, or the
/// student themself — deliberately NOT a linked parent (this is the
/// resolver behind GET /api/students/:id/parents; a parent doesn't need
/// this route to see their own household, and it isn't the place for a
/// second parent's contact details to leak to). A genuinely new resolver
/// rather than a reuse: no existing one keeps TEACHER+ADMIN+self while
/// excluding PARENT.
export async function canReadStudentParents(principal: Principal, studentId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
    return true;
  }
  if (principal.roles.has("STUDENT") && principal.studentId === studentId) {
    return true;
  }
  if (principal.roles.has("TEACHER") && principal.staffId) {
    return isTeacherAssignedToStudent(principal.staffId, studentId);
  }
  return false;
}

/// Self-access only (plus ADMIN) — no DB lookup needed since Staff.id is
/// already carried on the Principal, but routed through the same requireScope
/// mechanism as everything else so ownership checks stay in one place.
export function canReadStaff(principal: Principal, staffId: string): Promise<boolean> {
  return Promise.resolve(principal.roles.has("ADMIN") || principal.staffId === staffId);
}

/// The Parent-record analog of canReadStaff: self-access only (plus ADMIN),
/// no DB lookup needed since Parent.id is already carried on the Principal.
/// TEACHER is deliberately not consulted here — a teacher must not be able
/// to enumerate a family's structure (which children belong to which
/// parent) starting from a parent id, unlike canReadStudent's TEACHER
/// branch, which is about a specific already-known student.
export function canReadParent(principal: Principal, parentId: string): Promise<boolean> {
  return Promise.resolve(principal.roles.has("ADMIN") || principal.parentId === parentId);
}

/// "Teachers can only enter scores for classes/subjects assigned to them" —
/// this is the resolver that enforces it, shared by the roster, bulk score
/// upsert, and submit routes.
export async function canActOnAssignment(principal: Principal, assignmentId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
    return true;
  }
  if (principal.roles.has("TEACHER") && principal.staffId) {
    const assignment = await prisma.classSubjectAssignment.findUnique({
      where: { id: assignmentId },
      select: { teacherId: true },
    });
    return assignment?.teacherId === principal.staffId;
  }
  return false;
}

/// Financial data gets its own, narrower scope than canReadStudent: BURSAR
/// instead of TEACHER. Nothing in the PRD gives teachers visibility into fee
/// records, so this deliberately does NOT reuse canReadStudent.
export async function canReadStudentFinancials(principal: Principal, studentId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN") || principal.roles.has("BURSAR")) {
    return true;
  }
  if (principal.roles.has("STUDENT") && principal.studentId === studentId) {
    return true;
  }
  if (principal.roles.has("PARENT") && principal.parentId) {
    const link = await prisma.studentParent.findUnique({
      where: { studentId_parentId: { studentId, parentId: principal.parentId } },
      select: { id: true },
    });
    if (link !== null) {
      return true;
    }
  }
  return false;
}

export async function canReadPayment(principal: Principal, paymentId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN") || principal.roles.has("BURSAR")) {
    return true;
  }
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { feeObligation: { select: { studentId: true } } },
  });
  if (!payment) {
    return false;
  }
  return canReadStudentFinancials(principal, payment.feeObligation.studentId);
}

/// Same shape as canReadPayment: ADMIN/BURSAR always; anyone else only via
/// canReadStudentFinancials on the obligation's own student (a linked
/// parent, or the student themself).
export async function canReadFeeObligation(principal: Principal, feeObligationId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN") || principal.roles.has("BURSAR")) {
    return true;
  }
  const obligation = await prisma.feeObligation.findUnique({
    where: { id: feeObligationId },
    select: { studentId: true },
  });
  if (!obligation) {
    return false;
  }
  return canReadStudentFinancials(principal, obligation.studentId);
}

/// Timetable data isn't sensitive the way scores/fees are — "Maths is taught
/// in JSS1A at 10am Monday" carries no privacy concern — so any staff member
/// can view any class's timetable. Students/parents are scoped to classes
/// they (or their linked children) are actually, currently enrolled in.
export async function canReadClassTimetable(principal: Principal, classId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN") || principal.roles.has("TEACHER")) {
    return true;
  }

  if (principal.roles.has("STUDENT") && principal.studentId) {
    const enrollment = await prisma.enrollment.findFirst({
      where: {
        studentId: principal.studentId,
        classId,
        status: "ACTIVE",
        academicSession: { isCurrent: true },
      },
      select: { id: true },
    });
    if (enrollment !== null) {
      return true;
    }
  }

  if (principal.roles.has("PARENT") && principal.parentId) {
    const links = await prisma.studentParent.findMany({
      where: { parentId: principal.parentId },
      select: { studentId: true },
    });
    if (links.length > 0) {
      const enrollment = await prisma.enrollment.findFirst({
        where: {
          studentId: { in: links.map((l) => l.studentId) },
          classId,
          status: "ACTIVE",
          academicSession: { isCurrent: true },
        },
        select: { id: true },
      });
      if (enrollment !== null) {
        return true;
      }
    }
  }

  return false;
}

/// "The form teacher may write classTeacherComment on a DRAFT result for
/// their own class" — this is the resolver that enforces WHO. Deliberately
/// does not check Result.status (DRAFT vs FINALIZED): that's business state,
/// not identity, and belongs to writeClassTeacherComment()'s own 400, the
/// same split canActOnAssignment/canReadPayment already draw for their own
/// resolvers (see canReadPayment's "payment not found -> false" below for
/// the same not-found-collapses-to-denied precedent this mirrors).
export async function canWriteClassTeacherComment(
  principal: Principal,
  resultId: string,
): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
    return true;
  }
  if (!principal.roles.has("TEACHER") || !principal.staffId) {
    return false;
  }

  const result = await prisma.result.findUnique({
    where: { id: resultId },
    select: {
      enrollment: { select: { classId: true } },
      term: { select: { academicSessionId: true } },
    },
  });
  if (!result) {
    return false;
  }

  return isFormTeacherOfClass(principal.staffId, result.enrollment.classId, result.term.academicSessionId);
}

/// "The form teacher may read their own class's results for a term" — the
/// GET analog of canWriteClassTeacherComment, reached from a bare
/// classId+termId (a class-results listing, not one already-known result)
/// rather than a resultId, so it derives academicSessionId from the term
/// itself before calling the same shared form-teacher check. A SUBJECT
/// teacher assigned to this class is deliberately still denied — that
/// distinction (form teacher vs. subject teacher) is the whole point of
/// the ClassFormTeacher table, same as canWriteClassTeacherComment.
export async function canReadClassResults(
  principal: Principal,
  classId: string,
  termId: string,
): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
    return true;
  }
  if (!principal.roles.has("TEACHER") || !principal.staffId) {
    return false;
  }

  const term = await prisma.term.findUnique({ where: { id: termId }, select: { academicSessionId: true } });
  if (!term) {
    return false;
  }

  return isFormTeacherOfClass(principal.staffId, classId, term.academicSessionId);
}

/// "The form teacher may write affective/psychomotor ratings for their own
/// class's students, for a term" — same shape as canReadClassResults (ADMIN,
/// or the form teacher of this class+term specifically, not any subject
/// teacher), kept as its own named resolver rather than reusing
/// canReadClassResults directly so a reader of authMatrix.data.ts or the
/// route definition sees a write-shaped name, matching how
/// canWriteClassTeacherComment is its own function even though it also
/// ultimately calls isFormTeacherOfClass.
export async function canWriteClassRatings(
  principal: Principal,
  classId: string,
  termId: string,
): Promise<boolean> {
  return canReadClassResults(principal, classId, termId);
}

/// Self-access only (plus ADMIN) — the Student-record analog of
/// canReadStaff/canReadParent. No DB lookup needed: Student.id is already
/// carried on the Principal as studentId. Backs QR code self-rotation/read.
export function canManageStudentQrCode(principal: Principal, studentId: string): Promise<boolean> {
  return Promise.resolve(principal.roles.has("ADMIN") || principal.studentId === studentId);
}

/// A notification is manageable only by ADMIN or the user it was actually
/// sent to — there's no role-based path into someone else's notifications
/// at all, so this is a DB lookup, not a role check with a self-only
/// shortcut like canReadStaff/canReadParent/canManageStudentQrCode above.
export async function canManageOwnNotification(
  principal: Principal,
  notificationId: string,
): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
    return true;
  }
  const notification = await prisma.notificationEvent.findUnique({
    where: { id: notificationId },
    select: { recipientUserId: true },
  });
  return notification?.recipientUserId === principal.userId;
}
