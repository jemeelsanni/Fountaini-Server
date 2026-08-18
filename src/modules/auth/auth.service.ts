import { env } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { type AccessTokenPayload, signAccessToken } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateRefreshToken, hashRefreshToken } from "./tokens.js";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
}

interface LoginInput {
  email: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

async function buildAccessTokenPayload(userId: string): Promise<AccessTokenPayload> {
  const [staff, parent, student, userRoles] = await Promise.all([
    prisma.staff.findUnique({ where: { userId }, select: { id: true } }),
    prisma.parent.findUnique({ where: { userId }, select: { id: true } }),
    prisma.student.findUnique({ where: { userId }, select: { id: true } }),
    prisma.userRole.findMany({ where: { userId }, select: { role: true } }),
  ]);

  return {
    sub: userId,
    roles: userRoles.map((ur) => ur.role),
    staffId: staff?.id ?? null,
    parentId: parent?.id ?? null,
    studentId: student?.id ?? null,
  };
}

async function issueTokenPair(userId: string, ip?: string, userAgent?: string): Promise<IssuedTokens> {
  const payload = await buildAccessTokenPayload(userId);
  const accessToken = signAccessToken(payload);

  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const created = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      createdByIp: ip,
      userAgent,
    },
  });

  return { accessToken, refreshToken, refreshTokenId: created.id };
}

export async function login(input: LoginInput): Promise<IssuedTokens> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Invalid email or password");
  }

  const validPassword = await verifyPassword(user.passwordHash, input.password);
  if (!validPassword) {
    throw AppError.unauthorized("Invalid email or password");
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return issueTokenPair(user.id, input.ip, input.userAgent);
}

export async function refresh(rawToken: string, ip?: string, userAgent?: string): Promise<IssuedTokens> {
  const tokenHash = hashRefreshToken(rawToken);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing) {
    throw AppError.unauthorized("Invalid refresh token");
  }

  if (existing.expiresAt < new Date()) {
    throw AppError.unauthorized("Refresh token has expired");
  }

  if (!existing.user.isActive) {
    throw AppError.unauthorized("Account is deactivated");
  }

  // Atomic claim: only one concurrent caller can flip revokedAt null -> now.
  // Whoever loses this race is either replaying an already-rotated token
  // (compromise signal) or double-submitted the same request — either way,
  // exactly one new token pair may come out of one refresh token.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: existing.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (claimed.count === 0) {
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw AppError.unauthorized("Refresh token has already been used");
  }

  const newTokens = await issueTokenPair(existing.userId, ip, userAgent);

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { replacedByTokenId: newTokens.refreshTokenId },
  });

  return newTokens;
}

export async function logout(rawToken: string): Promise<void> {
  const tokenHash = hashRefreshToken(rawToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw AppError.unauthorized();
  }

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) {
    throw AppError.unauthorized("Current password is incorrect");
  }

  const newHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash: newHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
