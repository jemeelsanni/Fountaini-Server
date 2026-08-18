import type { Role } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { hashPassword } from "../auth/password.js";

const userListSelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

export async function createUser(input: { email: string; password: string; role: Role }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict("A user with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  return prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      role: input.role,
    },
    select: userListSelect,
  });
}

export function listUsers() {
  return prisma.user.findMany({
    select: userListSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userListSelect });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  return user;
}

export async function setUserActive(id: string, isActive: boolean) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw AppError.notFound("User not found");
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { isActive },
    select: userListSelect,
  });

  if (!isActive) {
    // Deactivation must kill live sessions immediately, not just block new logins.
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  return updated;
}
