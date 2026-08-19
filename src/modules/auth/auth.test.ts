import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { resetDb } from "../../test/resetDb.js";
import { hashPassword } from "./password.js";

const app = createApp();

type Role = "ADMIN" | "TEACHER" | "PARENT" | "STUDENT" | "BURSAR";

async function createTestUser(
  overrides: { email?: string; password?: string; role?: Role } = {},
) {
  const email = overrides.email ?? "user@test.local";
  const password = overrides.password ?? "correct-horse-battery-staple";
  const role = overrides.role ?? "ADMIN";
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, roles: { create: [{ role }] } },
  });
  return { user, email, password };
}

/// No UserRole rows at all — the degenerate case buildAccessTokenPayload()
/// rejects at token-issuance time rather than letting it authenticate and
/// then 403 on every subsequent request.
async function createRolelessUser(email: string, password: string) {
  const passwordHash = await hashPassword(password);
  return prisma.user.create({ data: { email, passwordHash } });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/auth/login", () => {
  it("issues an access and refresh token for correct credentials", async () => {
    const { email, password } = await createTestUser();

    const res = await request(app).post("/api/auth/login").send({ email, password });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
  });

  it("rejects an incorrect password", async () => {
    const { email } = await createTestUser({ password: "correct-password" });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrong-password" });

    expect(res.status).toBe(401);
  });

  it("rejects a deactivated user", async () => {
    const { user, email, password } = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const res = await request(app).post("/api/auth/login").send({ email, password });

    expect(res.status).toBe(401);
  });

  it("rejects an unknown email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@test.local", password: "x" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed request body", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects login for a user with no roles assigned, with a distinct error code", async () => {
    const email = "noroles@test.local";
    const password = "correct-horse-battery-staple";
    await createRolelessUser(email, password);

    const res = await request(app).post("/api/auth/login").send({ email, password });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_ROLES_ASSIGNED");
  });
});

describe("POST /api/auth/refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });

    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: loginRes.body.refreshToken });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.refreshToken).not.toBe(loginRes.body.refreshToken);
    // Not asserting accessToken !== previous accessToken: a JWT is a
    // deterministic function of its claims + iat (1s resolution), so an
    // immediate refresh with identical claims can legitimately re-derive the
    // same token. That's not a security issue — only the refresh token's
    // uniqueness (asserted above) matters for rotation correctness.
    expect(typeof refreshRes.body.accessToken).toBe("string");
  });

  it("rejects reuse of an already-rotated refresh token and revokes the session", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const originalRefreshToken = loginRes.body.refreshToken as string;

    const firstRefresh = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: originalRefreshToken });
    expect(firstRefresh.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: originalRefreshToken });
    expect(replay.status).toBe(401);

    // Reuse must have revoked the token that came out of the first rotation too.
    const secondRefreshAttempt = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: firstRefresh.body.refreshToken });
    expect(secondRefreshAttempt.status).toBe(401);
  });

  it("handles concurrent refresh attempts on the same token with exactly one winner", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const refreshToken = loginRes.body.refreshToken as string;

    const [a, b] = await Promise.all([
      request(app).post("/api/auth/refresh").send({ refreshToken }),
      request(app).post("/api/auth/refresh").send({ refreshToken }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 401]);
  });

  it("rejects an unknown refresh token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects refresh once a user's last role is gone, and still consumes the old token", async () => {
    const { email, password, user } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    expect(loginRes.status).toBe(200);

    await prisma.userRole.deleteMany({ where: { userId: user.id } });

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: loginRes.body.refreshToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("NO_ROLES_ASSIGNED");

    // The atomic claim on the refresh token happens before roles are
    // checked, so rejecting here must not leave the old token usable.
    const retry = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: loginRes.body.refreshToken });
    expect(retry.status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the refresh token so it can no longer be used", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const refreshToken = loginRes.body.refreshToken as string;

    const logoutRes = await request(app).post("/api/auth/logout").send({ refreshToken });
    expect(logoutRes.status).toBe(204);

    const refreshAfterLogout = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the principal for a valid access token", async () => {
    const { email, password, user } = await createTestUser({ role: "ADMIN" });
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${loginRes.body.accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.principal.userId).toBe(user.id);
    expect(meRes.body.principal.roles).toEqual(["ADMIN"]);
  });

  it("rejects a missing Authorization header", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed access token", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/change-password", () => {
  it("changes the password and revokes existing sessions", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const accessToken = loginRes.body.accessToken as string;
    const refreshToken = loginRes.body.refreshToken as string;

    const changeRes = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: password, newPassword: "a-brand-new-password" });

    expect(changeRes.status).toBe(204);

    const refreshAfterChange = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(refreshAfterChange.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "a-brand-new-password" });
    expect(newLogin.status).toBe(200);
  });

  it("rejects an incorrect current password", async () => {
    const { email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${loginRes.body.accessToken}`)
      .send({ currentPassword: "wrong", newPassword: "a-brand-new-password" });

    expect(res.status).toBe(401);
  });
});

/// requestPasswordReset() never returns the token (that would defeat the
/// point of emailing it) — it's only ever visible in the NotificationEvent
/// body the notification provider interface received, exactly like a real
/// user would only see it in their inbox. Reading it back this way in
/// tests, rather than reaching into auth.service.ts directly, is what
/// proves the whole delivery path (service -> createNotification ->
/// NotificationEvent row) actually works end to end.
async function readResetTokenFromNotification(userId: string): Promise<string> {
  const event = await prisma.notificationEvent.findFirst({
    where: { type: "PASSWORD_RESET", recipientUserId: userId },
    orderBy: { createdAt: "desc" },
  });
  const match = /password:\s*(\S+)/.exec(event?.body ?? "");
  if (!match?.[1]) {
    throw new Error("No password reset token found in any NotificationEvent for this user");
  }
  return match[1];
}

describe("POST /api/auth/forgot-password", () => {
  it("creates a reset token and delivers it through the notification provider for a real, active account", async () => {
    const { user, email } = await createTestUser();

    const res = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(res.status).toBe(204);

    const tokenRow = await prisma.passwordResetToken.findFirst({ where: { userId: user.id } });
    expect(tokenRow).not.toBeNull();
    expect(tokenRow?.usedAt).toBeNull();
    expect(tokenRow?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const event = await prisma.notificationEvent.findFirst({
      where: { type: "PASSWORD_RESET", recipientUserId: user.id },
    });
    expect(event).not.toBeNull();
  });

  it("responds identically (204, no body) for an email that doesn't belong to any account", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "nobody@test.local" });
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});

    const anyTokens = await prisma.passwordResetToken.count();
    expect(anyTokens, "no token should be created for an email with no account").toBe(0);
  });

  it("responds identically (204) for a deactivated account, and creates no token", async () => {
    const { user, email } = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const res = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(res.status).toBe(204);

    const tokens = await prisma.passwordResetToken.count({ where: { userId: user.id } });
    expect(tokens).toBe(0);
  });

  it("rejects a malformed email", async () => {
    const res = await request(app).post("/api/auth/forgot-password").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("sets a new password, allows login with it, and revokes every existing refresh token", async () => {
    const { user, email, password } = await createTestUser();
    const loginRes = await request(app).post("/api/auth/login").send({ email, password });
    const oldRefreshToken = loginRes.body.refreshToken as string;

    await request(app).post("/api/auth/forgot-password").send({ email });
    const token = await readResetTokenFromNotification(user.id);

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "a-brand-new-password" });
    expect(resetRes.status).toBe(204);

    const oldRefreshAttempt = await request(app).post("/api/auth/refresh").send({ refreshToken: oldRefreshToken });
    expect(oldRefreshAttempt.status, "the reset must revoke sessions that predate it").toBe(401);

    const oldPasswordLogin = await request(app).post("/api/auth/login").send({ email, password });
    expect(oldPasswordLogin.status).toBe(401);

    const newPasswordLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "a-brand-new-password" });
    expect(newPasswordLogin.status).toBe(200);
  });

  it("is single-use — a second attempt with the same token is rejected even with a valid new password", async () => {
    const { user, email } = await createTestUser();
    await request(app).post("/api/auth/forgot-password").send({ email });
    const token = await readResetTokenFromNotification(user.id);

    const first = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "first-new-password" });
    expect(first.status).toBe(204);

    const second = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "second-new-password" });
    expect(second.status).toBe(401);
  });

  it("resolves two concurrent uses of the same token as exactly one winner", async () => {
    const { user, email } = await createTestUser();
    await request(app).post("/api/auth/forgot-password").send({ email });
    const token = await readResetTokenFromNotification(user.id);

    const [a, b] = await Promise.all([
      request(app).post("/api/auth/reset-password").send({ token, newPassword: "candidate-password-a" }),
      request(app).post("/api/auth/reset-password").send({ token, newPassword: "candidate-password-b" }),
    ]);

    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([204, 401]);
  });

  it("rejects an unknown token", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "not-a-real-token", newPassword: "a-brand-new-password" });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { user, email } = await createTestUser();
    await request(app).post("/api/auth/forgot-password").send({ email });
    const token = await readResetTokenFromNotification(user.id);

    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "a-brand-new-password" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed request body", async () => {
    const res = await request(app).post("/api/auth/reset-password").send({ token: "x", newPassword: "short" });
    expect(res.status).toBe(400);
  });
});
