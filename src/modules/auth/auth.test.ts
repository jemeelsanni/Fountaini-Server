import argon2 from "argon2";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

type Role = "ADMIN" | "TEACHER" | "PARENT" | "STUDENT" | "BURSAR";

async function createTestUser(
  overrides: { email?: string; password?: string; role?: Role } = {},
) {
  const email = overrides.email ?? "user@test.local";
  const password = overrides.password ?? "correct-horse-battery-staple";
  const role = overrides.role ?? "ADMIN";
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await prisma.user.create({
    data: { email, passwordHash, roles: { create: [{ role }] } },
  });
  return { user, email, password };
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
