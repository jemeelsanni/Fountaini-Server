import argon2 from "argon2";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

async function createUserAndLogin(email: string, password: string, role: "ADMIN" | "TEACHER") {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await prisma.user.create({ data: { email, passwordHash, role } });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
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
  it("allows an admin to create a user", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "new.teacher@test.local", password: "a-secure-password", role: "TEACHER" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new.teacher@test.local");
    expect(res.body.role).toBe("TEACHER");
    expect(res.body.passwordHash).toBeUndefined();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app)
      .post("/api/users")
      .send({ email: "x@test.local", password: "a-secure-password", role: "STUDENT" });

    expect(res.status).toBe(401);
  });

  it("rejects a duplicate email", async () => {
    const adminToken = await createAdminAndLogin();

    await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", password: "a-secure-password", role: "TEACHER" });

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", password: "a-secure-password", role: "BURSAR" });

    expect(res.status).toBe(409);
  });

  it("rejects an invalid role", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "x@test.local", password: "a-secure-password", role: "NOT_A_ROLE" });

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
      .send({ email: "teacher@test.local", password: "teacher-password-123" });
    expect(loginAfterDeactivate.status).toBe(401);

    const reactivateRes = await request(app)
      .post(`/api/users/${teacherId}/activate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.isActive).toBe(true);

    const loginAfterReactivate = await request(app)
      .post("/api/auth/login")
      .send({ email: "teacher@test.local", password: "teacher-password-123" });
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
