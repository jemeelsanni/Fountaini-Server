import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateParentBody, LinkChildBody } from "./parents.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createParent(input: CreateParentBody) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { roles: true },
  });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  if (!user.roles.some((ur) => ur.role === "PARENT")) {
    throw AppError.badRequest("The linked user must have the PARENT role");
  }
  const existing = await prisma.parent.findUnique({ where: { userId: input.userId } });
  if (existing) {
    throw AppError.conflict("This user is already linked to a parent record");
  }

  try {
    return await prisma.parent.create({ data: input });
  } catch (err) {
    // The existence check above is a stale read the instant a concurrent
    // createParent for the same user lands between it and this create() —
    // the DB's own unique constraint on userId is the real backstop.
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("This user is already linked to a parent record");
    }
    throw err;
  }
}

export function listParents() {
  return prisma.parent.findMany({ orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
}

export async function getParentById(id: string) {
  const parent = await prisma.parent.findUnique({ where: { id } });
  if (!parent) {
    throw AppError.notFound("Parent not found");
  }
  return parent;
}

export async function linkChild(parentId: string, input: LinkChildBody) {
  const [parent, student] = await Promise.all([
    prisma.parent.findUnique({ where: { id: parentId } }),
    prisma.student.findUnique({ where: { id: input.studentId } }),
  ]);
  if (!parent) throw AppError.notFound("Parent not found");
  if (!student) throw AppError.notFound("Student not found");

  try {
    return await prisma.studentParent.create({
      data: {
        parentId,
        studentId: input.studentId,
        relationship: input.relationship,
        isPrimaryContact: input.isPrimaryContact ?? false,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw AppError.conflict("This student is already linked to this parent");
    }
    throw err;
  }
}

export async function unlinkChild(parentId: string, studentId: string) {
  // deleteMany rather than findUnique-then-delete: a concurrent unlink of
  // the same pair racing in between would make the delete-by-id throw
  // P2025 (unhandled -> 500) once the row it found is already gone.
  // deleteMany matches fresh at delete time and just reports 0 affected
  // rows instead of erroring, which cleanly becomes the same 404.
  const { count } = await prisma.studentParent.deleteMany({ where: { studentId, parentId } });
  if (count === 0) {
    throw AppError.notFound("This student is not linked to this parent");
  }
}

export function listChildrenForParent(parentId: string) {
  return prisma.studentParent.findMany({
    where: { parentId },
    include: { student: true },
  });
}
