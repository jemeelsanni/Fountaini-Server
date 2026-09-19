import { Prisma, type Role } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { generateTemporaryPassword, hashPassword } from "../auth/password.js";
import { createNotification } from "../notifications/notifications.service.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const userListSelect = {
  id: true,
  loginId: true,
  email: true,
  mustChangePassword: true,
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

export async function createUser(input: { email: string; role: Role }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict("A user with this email already exists");
  }

  // Admin-created accounts never get an admin-chosen password — always
  // generated, always mustChangePassword: true, same as
  // students.service.ts/staff.service.ts's atomic creation paths. Here,
  // email is always the destination (it's required by createUserSchema
  // and IS this account's loginId), so unlike student creation there's no
  // "no destination, return it in the response" fallback — this account
  // always has somewhere to send it.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  let user;
  try {
    user = await prisma.user.create({
      data: {
        loginId: input.email,
        email: input.email,
        passwordHash,
        mustChangePassword: true,
        roles: { create: [{ role: input.role }] },
      },
      select: userListSelect,
    });
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

  fireAndForget(
    createNotification({
      type: "CREDENTIALS_ISSUED",
      recipientUserId: user.id,
      subject: "Your school portal login",
      body:
        `Your login ID is ${input.email}. Temporary password: ${temporaryPassword}. ` +
        `You'll be asked to change it the first time you sign in.`,
      channels: ["EMAIL"],
      relatedEntityType: "User",
      relatedEntityId: user.id,
    }),
    (err) => logger.error({ err }, "Failed to send user credential notification"),
  );

  return flattenRoles(user);
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
