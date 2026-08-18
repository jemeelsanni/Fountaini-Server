import { prisma } from "../db/client.js";
import type { Principal } from "./types.js";

/// A student's record is readable by: any ADMIN; the student themself; a
/// parent linked via StudentParent; or a teacher currently assigned (via
/// ClassSubjectAssignment, scoped to the CURRENT academic session) to the
/// class the student is actively enrolled in this session.
///
/// A principal can hold more than one of these roles at once (a
/// staff-parent, say) — each branch below only ever returns early on a
/// match and otherwise falls through to the next, so a role that doesn't
/// apply here never suppresses a different role that does.
export async function canReadStudent(principal: Principal, studentId: string): Promise<boolean> {
  if (principal.roles.has("ADMIN")) {
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

  if (principal.roles.has("TEACHER") && principal.staffId) {
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId, status: "ACTIVE", academicSession: { isCurrent: true } },
      select: { classId: true, academicSessionId: true },
    });

    if (enrollments.length > 0) {
      const assignment = await prisma.classSubjectAssignment.findFirst({
        where: {
          teacherId: principal.staffId,
          OR: enrollments.map((e) => ({ classId: e.classId, academicSessionId: e.academicSessionId })),
        },
        select: { id: true },
      });
      if (assignment !== null) {
        return true;
      }
    }
  }

  return false;
}

/// Self-access only (plus ADMIN) — no DB lookup needed since Staff.id is
/// already carried on the Principal, but routed through the same requireScope
/// mechanism as everything else so ownership checks stay in one place.
export function canReadStaff(principal: Principal, staffId: string): Promise<boolean> {
  return Promise.resolve(principal.roles.has("ADMIN") || principal.staffId === staffId);
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
