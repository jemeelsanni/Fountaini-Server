import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type {
  CreateAcademicSessionBody,
  CreateClassBody,
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

  const [, updated] = await prisma.$transaction([
    prisma.academicSession.updateMany({
      where: { isCurrent: true, NOT: { id } },
      data: { isCurrent: false },
    }),
    prisma.academicSession.update({ where: { id }, data: { isCurrent: true } }),
  ]);

  return updated;
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

  const [, updated] = await prisma.$transaction([
    prisma.term.updateMany({
      where: { academicSessionId: term.academicSessionId, isCurrent: true, NOT: { id } },
      data: { isCurrent: false },
    }),
    prisma.term.update({ where: { id }, data: { isCurrent: true } }),
  ]);

  return updated;
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
    prisma.staff.findUnique({ where: { id: input.teacherId }, include: { user: true } }),
  ]);

  if (!klass) throw AppError.notFound("Class not found");
  if (!subject) throw AppError.notFound("Subject not found");
  if (!session) throw AppError.notFound("Academic session not found");
  if (!teacher) throw AppError.notFound("Teacher (staff) not found");
  if (teacher.user.role !== "TEACHER" && teacher.user.role !== "ADMIN") {
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
  const assignment = await prisma.classSubjectAssignment.findUnique({ where: { id } });
  if (!assignment) {
    throw AppError.notFound("Assignment not found");
  }
  await prisma.classSubjectAssignment.delete({ where: { id } });
}
