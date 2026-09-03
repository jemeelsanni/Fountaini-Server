import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateEnrollmentBody, CreateStudentBody, UpdateStudentBody } from "./students.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createStudent(input: CreateStudentBody) {
  if (input.userId) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      include: { roles: true },
    });
    if (!user) {
      throw AppError.notFound("User not found");
    }
    if (!user.roles.some((ur) => ur.role === "STUDENT")) {
      throw AppError.badRequest("The linked user must have the STUDENT role");
    }
    const existingStudent = await prisma.student.findUnique({ where: { userId: input.userId } });
    if (existingStudent) {
      throw AppError.conflict("This user is already linked to a student record");
    }
  }

  try {
    return await prisma.student.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A student with this admission number already exists");
    }
    throw err;
  }
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

  if (input.userId) {
    const user = await prisma.user.findUnique({ where: { id: input.userId }, include: { roles: true } });
    if (!user) {
      throw AppError.notFound("User not found");
    }
    if (!user.roles.some((ur) => ur.role === "STUDENT")) {
      throw AppError.badRequest("The linked user must have the STUDENT role");
    }
  }

  try {
    if (input.userId) {
      // Conditional claim, not read-then-write: the WHERE clause re-checks
      // userId is still null at write time, so two concurrent attaches to
      // the same student can't both succeed (see docs/concurrency.md). The
      // "target user already linked to a DIFFERENT student" case is caught
      // below instead — Student.userId's own DB-level unique constraint
      // (schema.prisma) rejects that write outright as a P2002, regardless
      // of this WHERE clause.
      const { count } = await prisma.student.updateMany({ where: { id, userId: null }, data: input });
      if (count === 0) {
        throw AppError.conflict("This student already has a linked user account");
      }
      return await prisma.student.findUniqueOrThrow({ where: { id } });
    }
    return await prisma.student.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict(
        input.userId
          ? "This user is already linked to another student record"
          : "A student with this admission number already exists",
      );
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
