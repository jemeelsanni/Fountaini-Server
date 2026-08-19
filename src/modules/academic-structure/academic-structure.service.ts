import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type {
  CreateAcademicSessionBody,
  CreateClassBody,
  CreateClassFormTeacherBody,
  CreateClassSubjectAssignmentBody,
  CreateSubjectBody,
  CreateTermBody,
} from "./academic-structure.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// ---------------------------------------------------------------------------
// Academic sessions
// ---------------------------------------------------------------------------

export async function createAcademicSession(input: CreateAcademicSessionBody) {
  try {
    return await prisma.academicSession.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("An academic session with this name already exists");
    }
    throw err;
  }
}

export function listAcademicSessions() {
  return prisma.academicSession.findMany({ orderBy: { startDate: "desc" } });
}

export async function setCurrentAcademicSession(id: string) {
  const session = await prisma.academicSession.findUnique({ where: { id } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  return prisma.$transaction(async (tx) => {
    // Transaction-scoped advisory lock (released automatically at commit or
    // rollback) fully serializes set-current calls — needed because a plain
    // updateMany(clear others)-then-update(set self), even inside one
    // transaction, has a real gap under 3-or-more-way concurrency: an
    // updateMany's candidate rows are fixed by its snapshot taken BEFORE it
    // blocks on a row lock. If it blocks waiting for the previously-current
    // row and only unblocks after a DIFFERENT concurrent switch has already
    // committed a new current row, it never re-scans to catch that new row
    // — verified empirically (reliably reproducible with 4 concurrent
    // switches; not reliably with 2, which is why this stayed unnoticed).
    // Serializing here means only one switch is ever actually in flight, so
    // the partial unique index below never trips on a legitimate switch.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('academic_session_set_current'))`;

    await tx.academicSession.updateMany({
      where: { isCurrent: true, NOT: { id } },
      data: { isCurrent: false },
    });
    return tx.academicSession.update({ where: { id }, data: { isCurrent: true } });
  });
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export async function createTerm(academicSessionId: string, input: CreateTermBody) {
  const session = await prisma.academicSession.findUnique({ where: { id: academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  try {
    return await prisma.term.create({ data: { ...input, academicSessionId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A term with this order already exists in this session");
    }
    throw err;
  }
}

export function listTermsForSession(academicSessionId: string) {
  return prisma.term.findMany({ where: { academicSessionId }, orderBy: { order: "asc" } });
}

export async function setCurrentTerm(id: string) {
  const term = await prisma.term.findUnique({ where: { id } });
  if (!term) {
    throw AppError.notFound("Term not found");
  }

  return prisma.$transaction(async (tx) => {
    // See setCurrentAcademicSession()'s comment for why this lock is
    // necessary, not just the partial unique index. Scoped to this specific
    // academicSessionId (two-key advisory lock) rather than globally, so
    // concurrent term switches in different sessions don't serialize
    // against each other unnecessarily.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('term_set_current'), hashtext(${term.academicSessionId}))`;

    await tx.term.updateMany({
      where: { academicSessionId: term.academicSessionId, isCurrent: true, NOT: { id } },
      data: { isCurrent: false },
    });
    return tx.term.update({ where: { id }, data: { isCurrent: true } });
  });
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export async function createClass(input: CreateClassBody) {
  try {
    return await prisma.class.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A class with this grade name and arm already exists");
    }
    throw err;
  }
}

export function listClasses() {
  return prisma.class.findMany({ orderBy: [{ order: "asc" }, { arm: "asc" }] });
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export async function createSubject(input: CreateSubjectBody) {
  try {
    return await prisma.subject.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A subject with this code already exists");
    }
    throw err;
  }
}

export function listSubjects() {
  return prisma.subject.findMany({ orderBy: { name: "asc" } });
}

// ---------------------------------------------------------------------------
// Class-subject-teacher assignments
// ---------------------------------------------------------------------------

export async function createClassSubjectAssignment(input: CreateClassSubjectAssignmentBody) {
  const [klass, subject, session, teacher] = await Promise.all([
    prisma.class.findUnique({ where: { id: input.classId } }),
    prisma.subject.findUnique({ where: { id: input.subjectId } }),
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId } }),
    prisma.staff.findUnique({ where: { id: input.teacherId }, include: { user: { include: { roles: true } } } }),
  ]);

  if (!klass) throw AppError.notFound("Class not found");
  if (!subject) throw AppError.notFound("Subject not found");
  if (!session) throw AppError.notFound("Academic session not found");
  if (!teacher) throw AppError.notFound("Teacher (staff) not found");
  const teacherRoles = new Set(teacher.user.roles.map((ur) => ur.role));
  if (!teacherRoles.has("TEACHER") && !teacherRoles.has("ADMIN")) {
    throw AppError.badRequest("The assigned staff member must have the TEACHER (or ADMIN) role");
  }

  try {
    return await prisma.classSubjectAssignment.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This class/subject already has a teacher assigned for this session");
    }
    throw err;
  }
}

export function listClassSubjectAssignments(filter: { teacherId?: string; classId?: string }) {
  return prisma.classSubjectAssignment.findMany({
    where: {
      teacherId: filter.teacherId,
      classId: filter.classId,
    },
    include: { class: true, subject: true, teacher: true, academicSession: true },
  });
}

export async function deleteClassSubjectAssignment(id: string) {
  // deleteMany rather than findUnique-then-delete: a concurrent delete of
  // the same id racing in between would make delete-by-id throw P2025
  // (unhandled -> 500) once the row it found is already gone. deleteMany
  // matches fresh at delete time and just reports 0 affected rows instead
  // of erroring, which cleanly becomes the same 404.
  const { count } = await prisma.classSubjectAssignment.deleteMany({ where: { id } });
  if (count === 0) {
    throw AppError.notFound("Assignment not found");
  }
}

// ---------------------------------------------------------------------------
// Class form teachers
// ---------------------------------------------------------------------------

export async function createClassFormTeacher(input: CreateClassFormTeacherBody) {
  const [klass, session, teacher] = await Promise.all([
    prisma.class.findUnique({ where: { id: input.classId } }),
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId } }),
    prisma.staff.findUnique({ where: { id: input.teacherId }, include: { user: { include: { roles: true } } } }),
  ]);

  if (!klass) throw AppError.notFound("Class not found");
  if (!session) throw AppError.notFound("Academic session not found");
  if (!teacher) throw AppError.notFound("Teacher (staff) not found");
  const teacherRoles = new Set(teacher.user.roles.map((ur) => ur.role));
  if (!teacherRoles.has("TEACHER") && !teacherRoles.has("ADMIN")) {
    throw AppError.badRequest("The assigned staff member must have the TEACHER (or ADMIN) role");
  }

  try {
    return await prisma.classFormTeacher.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This class already has a form teacher assigned for this session");
    }
    throw err;
  }
}

export function listClassFormTeachers(filter: { teacherId?: string; classId?: string }) {
  return prisma.classFormTeacher.findMany({
    where: {
      teacherId: filter.teacherId,
      classId: filter.classId,
    },
    include: { class: true, teacher: true, academicSession: true },
  });
}

export async function deleteClassFormTeacher(id: string) {
  // Same deleteMany-then-count reasoning as deleteClassSubjectAssignment
  // above: avoids an unhandled P2025 on a concurrent double-delete.
  const { count } = await prisma.classFormTeacher.deleteMany({ where: { id } });
  if (count === 0) {
    throw AppError.notFound("Form teacher assignment not found");
  }
}
