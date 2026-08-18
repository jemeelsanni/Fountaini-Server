import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateStaffBody, UpdateStaffBody } from "./staff.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createStaff(input: CreateStaffBody) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    include: { roles: true },
  });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  const userRoles = new Set(user.roles.map((ur) => ur.role));
  if (!userRoles.has("TEACHER") && !userRoles.has("ADMIN") && !userRoles.has("BURSAR")) {
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

const staffUserSelect = { email: true, roles: { select: { role: true } } } as const;

function flattenUserRoles<U extends { roles: { role: Role }[] }, S extends { user: U }>(
  staff: S,
): Omit<S, "user"> & { user: Omit<U, "roles"> & { roles: Role[] } } {
  return {
    ...staff,
    user: { ...staff.user, roles: staff.user.roles.map((ur) => ur.role) },
  };
}

export async function listStaff() {
  const staff = await prisma.staff.findMany({
    include: { user: { select: staffUserSelect } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return staff.map((s) => flattenUserRoles(s));
}

export async function getStaffById(id: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: { user: { select: staffUserSelect } },
  });
  if (!staff) {
    throw AppError.notFound("Staff member not found");
  }
  return flattenUserRoles(staff);
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
