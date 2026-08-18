import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateParentBody, LinkChildBody } from "./parents.schemas.js";

export async function createParent(input: CreateParentBody) {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  if (user.role !== "PARENT") {
    throw AppError.badRequest("The linked user must have the PARENT role");
  }
  const existing = await prisma.parent.findUnique({ where: { userId: input.userId } });
  if (existing) {
    throw AppError.conflict("This user is already linked to a parent record");
  }

  return prisma.parent.create({ data: input });
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
  const link = await prisma.studentParent.findUnique({
    where: { studentId_parentId: { studentId, parentId } },
  });
  if (!link) {
    throw AppError.notFound("This student is not linked to this parent");
  }
  await prisma.studentParent.delete({ where: { id: link.id } });
}

export function listChildrenForParent(parentId: string) {
  return prisma.studentParent.findMany({
    where: { parentId },
    include: { student: true },
  });
}
