import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { hashPassword } from "../auth/password.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const userListSelect = {
  id: true,
  email: true,
  roles: { select: { role: true } },
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

function flattenRoles<T extends { roles: { role: Role }[] }>(
  user: T,
): Omit<T, "roles"> & { roles: Role[] } {
  return { ...user, roles: user.roles.map((ur) => ur.role) };
}

export async function createUser(input: { email: string; password: string; role: Role }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict("A user with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        roles: { create: [{ role: input.role }] },
      },
      select: userListSelect,
    });
    return flattenRoles(user);
  } catch (err) {
    // The existence check above is a stale read the instant a concurrent
    // signup for the same email lands between it and this create() — the
    // DB's own unique constraint is the real backstop, translated into the
    // same 409 the pre-check gives rather than an unhandled 500.
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A user with this email already exists");
    }
    throw err;
  }
}

export async function listUsers() {
  const users = await prisma.user.findMany({
    select: userListSelect,
    orderBy: { createdAt: "desc" },
  });
  return users.map(flattenRoles);
}

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userListSelect });
  if (!user) {
    throw AppError.notFound("User not found");
  }
  return flattenRoles(user);
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

  return flattenRoles(updated);
}
