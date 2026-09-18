import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { hashPassword } from "../auth/password.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

async function createUserAndLogin(email: string, password: string, role: "ADMIN" | "TEACHER") {
  const passwordHash = await hashPassword(password);
  await prisma.user.create({
    data: { loginId: email, email, passwordHash, roles: { create: [{ role }] } },
  });
  const loginRes = await request(app).post("/api/auth/login").send({ identifier: email, password });
  return loginRes.body.accessToken as string;
}

const createAdminAndLogin = () => createUserAndLogin("admin@test.local", "admin-password-123", "ADMIN");
const createTeacherAndLogin = () =>
  createUserAndLogin("teacher@test.local", "teacher-password-123", "TEACHER");

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/users", () => {
  it("allows an admin to create a user with a generated, unrecoverable-by-admin password", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "new.teacher@test.local", role: "TEACHER" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new.teacher@test.local");
    expect(res.body.roles).toEqual(["TEACHER"]);
    expect(res.body.passwordHash).toBeUndefined();
    // Unlike student creation's no-destination fallback, this account
    // always has a destination (its own, required email) — the password
    // is only ever delivered by notification, never in the response.
    expect(res.body.temporaryPassword).toBeUndefined();

    const created = await prisma.user.findUniqueOrThrow({ where: { email: "new.teacher@test.local" } });
    expect(created.loginId).toBe("new.teacher@test.local");
    expect(created.mustChangePassword).toBe(true);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@test.local", role: "TEACHER" });

    expect(res.status).toBe(401);
  });

  it("rejects a duplicate email", async () => {
    const adminToken = await createAdminAndLogin();

    await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "TEACHER" });

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "BURSAR" });

    expect(res.status).toBe(409);
  });

  // loginId is one shared namespace across every account type — this
  // proves a PARENT's email is checked against it even when the existing
  // collision came from creating a completely different role (a bare
  // TEACHER account here), not just a second PARENT.
  it("rejects a parent whose email collides with an existing (different-role) account's loginId", async () => {
    const adminToken = await createAdminAndLogin();

    const teacherRes = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "shared-identifier@test.local", role: "TEACHER" });
    expect(teacherRes.status).toBe(201);

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "shared-identifier@test.local", role: "PARENT" });

    expect(res.status).toBe(409);
  });

  it("rejects an invalid role", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "x@test.local", role: "NOT_A_ROLE" });

    expect(res.status).toBe(400);
  });

  it("rejects STUDENT — every student is created via POST /api/students instead", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "x@test.local", role: "STUDENT" });

    expect(res.status).toBe(400);
  });
});

describe("user activation lifecycle", () => {
  it("deactivating a user revokes their active sessions until reactivated", async () => {
    const adminToken = await createAdminAndLogin();
    const teacherToken = await createTeacherAndLogin();

    const meBefore = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${teacherToken}`);
    const teacherId = meBefore.body.principal.userId as string;

    const deactivateRes = await request(app)
      .post(`/api/users/${teacherId}/deactivate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.isActive).toBe(false);

    const loginAfterDeactivate = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "teacher@test.local", password: "teacher-password-123" });
    expect(loginAfterDeactivate.status).toBe(401);

    const reactivateRes = await request(app)
      .post(`/api/users/${teacherId}/activate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.isActive).toBe(true);

    const loginAfterReactivate = await request(app)
      .post("/api/auth/login")
      .send({ identifier: "teacher@test.local", password: "teacher-password-123" });
    expect(loginAfterReactivate.status).toBe(200);
  });
});

describe("GET /api/users/:id", () => {
  it("returns 404 for a nonexistent user", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .get("/api/users/does-not-exist")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});
