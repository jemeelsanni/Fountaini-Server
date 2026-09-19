import { env } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { createNotification } from "../notifications/notifications.service.js";
import { resolvePrimaryContactParent } from "../students/students.service.js";
import { type AccessTokenPayload, signAccessToken } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateOpaqueToken, hashOpaqueToken } from "./tokens.js";

const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenId: string;
}

interface LoginInput {
  identifier: string;
  password: string;
  ip?: string;
  userAgent?: string;
}

/// The one lookup login()/requestPasswordReset() share: resolve by loginId
/// alone. Only a parent (or a bare account with no linked record) signs in
/// with something email-shaped at all — and for them, loginId already IS
/// their email (see User.loginId's own schema comment; nothing ever lets
/// the two diverge — there's no endpoint that updates a User's email
/// independently of loginId). A separate email fallback would only ever
/// matter if that could happen, so there's no OR query, and no >1-match
/// case to guard against: loginId is `@unique`, so `findUnique` can only
/// ever resolve to zero or one account by construction.
function findUserByIdentifier(identifier: string) {
  return prisma.user.findUnique({ where: { loginId: identifier } });
}

async function buildAccessTokenPayload(userId: string): Promise<AccessTokenPayload> {
  const [staff, parent, student, userRoles] = await Promise.all([
    prisma.staff.findUnique({ where: { userId }, select: { id: true } }),
    prisma.parent.findUnique({ where: { userId }, select: { id: true } }),
    prisma.student.findUnique({ where: { userId }, select: { id: true } }),
    prisma.userRole.findMany({ where: { userId }, select: { role: true } }),
  ]);

  // Every current path that creates a User creates exactly one UserRole row
  // in the same operation (see users.service.ts's createUser) — there is no
  // "remove a user's last role" feature yet either, so this shouldn't be
  // reachable through the API today. It exists as an explicit boundary
  // check anyway: this is the one place that would otherwise silently issue
  // a token that authenticates successfully and then is denied on every
  // single subsequent request with a plain 403, indistinguishable from an
  // ordinary permission failure. Reject at issuance instead, with a
  // specific reason, for whatever future path (direct DB edit, a role-
  // revocation feature that doesn't yet exist) could produce this state.
  if (userRoles.length === 0) {
    throw AppError.noRolesAssigned();
  }

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

  const refreshToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const created = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashOpaqueToken(refreshToken),
      expiresAt,
      createdByIp: ip,
      userAgent,
    },
  });

  return { accessToken, refreshToken, refreshTokenId: created.id };
}

export async function login(input: LoginInput): Promise<IssuedTokens> {
  const user = await findUserByIdentifier(input.identifier);

  if (!user || !user.isActive) {
    throw AppError.unauthorized("Invalid identifier or password");
  }

  const validPassword = await verifyPassword(user.passwordHash, input.password);
  if (!validPassword) {
    throw AppError.unauthorized("Invalid identifier or password");
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return issueTokenPair(user.id, input.ip, input.userAgent);
}

export async function refresh(rawToken: string, ip?: string, userAgent?: string): Promise<IssuedTokens> {
  const tokenHash = hashOpaqueToken(rawToken);
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
  const tokenHash = hashOpaqueToken(rawToken);
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
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, mustChangePassword: false },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

/// Deliberately returns the same thing (nothing, no throw) whether or not
/// `identifier` belongs to a real, active account with somewhere to send
/// the mail — the caller must never be able to tell any of these cases
/// apart from the response, or this endpoint becomes an account-
/// enumeration oracle. That matters more here than it did when this only
/// took an email: admission numbers are sequential and trivially
/// enumerable (FIA/2026/001 through FIA/2026/400 is a guessable space in a
/// way email addresses aren't), so the generic response and the existing
/// rate limit are load-bearing, not belt-and-braces.
///
/// Destination resolution: the user's own email if set; otherwise, if the
/// user is a student, their primary-contact (or earliest-linked, if none
/// is flagged primary) parent's email; otherwise nothing is sent. The
/// PasswordResetToken is still always issued against the account actually
/// being reset (`user.id`) — only the notification's recipient differs
/// when it's redirected to a parent, same as credential delivery.
export async function requestPasswordReset(identifier: string): Promise<void> {
  const user = await findUserByIdentifier(identifier);
  if (!user || !user.isActive) {
    return;
  }

  let recipientUserId: string;
  if (user.email) {
    recipientUserId = user.id;
  } else {
    const student = await prisma.student.findUnique({ where: { userId: user.id }, select: { id: true } });
    const contact = student ? await resolvePrimaryContactParent(student.id) : null;
    const parentEmail = contact?.parent.user.email;
    if (!contact || !parentEmail) {
      return;
    }
    recipientUserId = contact.parent.userId;
  }

  const rawToken = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60 * 1000);

  const resetToken = await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashOpaqueToken(rawToken), expiresAt },
  });

  // The raw token itself, not a clickable link: this is an API-only
  // backend with no frontend page to link to yet. A future frontend would
  // replace this body with a real reset-password URL carrying the token as
  // a query param; nothing else about this flow would need to change.
  await createNotification({
    type: "PASSWORD_RESET",
    recipientUserId,
    subject: "Reset your password",
    body:
      `A password reset was requested for this account. Submit the following token to ` +
      `POST /api/auth/reset-password within ${PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes to set a new ` +
      `password: ${rawToken}\n\nIf you didn't request this, no action is needed — your password has not changed.`,
    channels: ["EMAIL"],
    relatedEntityType: "PasswordResetToken",
    relatedEntityId: resetToken.id,
  });
}

/// Single-use (claimed atomically — same conditional-updateMany shape as
/// refresh()'s rotation claim above, see docs/concurrency.md), short expiry
/// (PASSWORD_RESET_TOKEN_TTL_MINUTES), and invalidates every one of this
/// user's live refresh tokens on success — a password reset is exactly the
/// moment every existing session should be forced to re-authenticate, same
/// as changePassword() above.
export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = hashOpaqueToken(rawToken);
  const existing = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!existing) {
    throw AppError.unauthorized("Invalid reset token");
  }
  if (existing.usedAt) {
    throw AppError.unauthorized("This reset token has already been used");
  }
  if (existing.expiresAt < new Date()) {
    throw AppError.unauthorized("Reset token has expired");
  }

  // Atomic claim: only one concurrent caller can flip usedAt null -> now —
  // whoever loses this race hits the same "already used" rejection as a
  // genuine replay, rather than both racers silently succeeding.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: existing.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw AppError.unauthorized("This reset token has already been used");
  }

  const newHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: existing.userId }, data: { passwordHash: newHash } }),
    prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
