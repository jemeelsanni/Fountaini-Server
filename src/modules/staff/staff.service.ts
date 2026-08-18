import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateStaffBody, UpdateStaffBody } from "./staff.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createStaff(input: CreateStaffBody) {
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  if (user.role !== "TEACHER" && user.role !== "ADMIN" && user.role !== "BURSAR") {
    throw AppError.badRequest("The linked user must have the ADMIN, TEACHER, or BURSAR role");
  }
  const existing = await prisma.staff.findUnique({ where: { userId: input.userId } });
  if (existing) {
    throw AppError.conflict("This user is already linked to a staff record");
  }

  try {
    return await prisma.staff.create({ data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A staff member with this staff number already exists");
    }
    throw err;
  }
}

export function listStaff() {
  return prisma.staff.findMany({
    include: { user: { select: { email: true, role: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
}

export async function getStaffById(id: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: { user: { select: { email: true, role: true } } },
  });
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }
  return staff;
}

export async function updateStaff(id: string, input: UpdateStaffBody) {
  const staff = await prisma.staff.findUnique({ where: { id } });
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }

  try {
    return await prisma.staff.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A staff member with this staff number already exists");
    }
    throw err;
  }
}
