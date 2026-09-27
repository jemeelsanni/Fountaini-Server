import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { hashPassword } from "../auth/password.js";
import { drainFireAndForget } from "../../lib/fireAndForget.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForNotification } from "../../test/waitForNotification.js";

const app = createApp();

async function createUserAndLogin(email: string, password: string, role: "ADMIN" | "TEACHER") {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { loginId: email, email, passwordHash, roles: { create: [{ role }] } },
  });
  // A TEACHER-role account always implies a linked Staff record now (see
  // auth.service.ts's buildAccessTokenPayload) — login() rejects a bare one.
  if (role === "TEACHER") {
    await prisma.staff.create({
      data: { userId: user.id, staffNumber: "FIA/ST2026/001", firstName: "Test", lastName: "Teacher" },
    });
  }
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
  it("allows an admin to create a bare ADMIN account with a generated, unrecoverable-by-admin password", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "new.admin@test.local", role: "ADMIN" });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe("new.admin@test.local");
    expect(res.body.roles).toEqual(["ADMIN"]);
    expect(res.body.passwordHash).toBeUndefined();
    // Unlike student creation's no-destination fallback, this account
    // always has a destination (its own, required email) — the password
    // is only ever delivered by notification, never in the response.
    expect(res.body.temporaryPassword).toBeUndefined();

    const created = await prisma.user.findUniqueOrThrow({ where: { email: "new.admin@test.local" } });
    expect(created.loginId).toBe("new.admin@test.local");
    expect(created.mustChangePassword).toBe(true);

    // Drain the fire-and-forget credential notification before this test
    // ends — an unawaited one can otherwise land mid-way through a later
    // test's resetDb() and trip its FK.
    await waitForNotification(res.body.id as string, "User", res.body.id as string);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/users").send({ email: "x@test.local", role: "ADMIN" });

    expect(res.status).toBe(401);
  });

  it("rejects a duplicate email", async () => {
    const adminToken = await createAdminAndLogin();

    const first = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "ADMIN" });
    await waitForNotification(first.body.id as string, "User", first.body.id as string);

    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "ADMIN" });

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

  // TEACHER/BURSAR now go through POST /api/staff, PARENT through
  // POST /api/parents, and STUDENT through POST /api/students — all three
  // atomic (User + profile record together, in one transaction). This
  // route is narrowed to the one account type left with no profile record
  // of its own: a bare ADMIN bootstrap account.
  it("rejects every role except ADMIN — each now has its own atomic creation path elsewhere", async () => {
    const adminToken = await createAdminAndLogin();

    for (const role of ["TEACHER", "PARENT", "BURSAR", "STUDENT"]) {
      const res = await request(app)
        .post("/api/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ email: `${role.toLowerCase()}@test.local`, role });
      expect(res.status, `role ${role} must be rejected`).toBe(400);
    }
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

  // Mirrors students.test.ts's "never persists the reissued password into
  // the audit log" test, on the new path: activate/deactivate's fetchBefore
  // reads a full, unprojected User row (unlike userListSelect, which every
  // response in this module goes through) specifically so beforeData
  // carries more than just isActive — but that same raw row is the first
  // thing in this codebase to put passwordHash in front of auditMutation()
  // at all. Proves redact() actually strips it before it's persisted, not
  // just that userListSelect coincidentally never included it.
  it("never persists passwordHash into the audit log's beforeData, for either activate or deactivate", async () => {
    const adminToken = await createAdminAndLogin();
    const teacherToken = await createTeacherAndLogin();
    const meBefore = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${teacherToken}`);
    const teacherId = meBefore.body.principal.userId as string;
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: teacherId } });
    expect(passwordHash).toBeTruthy();

    await request(app).post(`/api/users/${teacherId}/deactivate`).set("Authorization", `Bearer ${adminToken}`);
    await request(app).post(`/api/users/${teacherId}/activate`).set("Authorization", `Bearer ${adminToken}`);
    await drainFireAndForget();

    const entries = await prisma.auditLog.findMany({
      where: { entityType: "User", entityId: teacherId, action: { in: ["USER_DEACTIVATED", "USER_ACTIVATED"] } },
    });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const beforeData = entry.beforeData as Record<string, unknown> | null;
      expect(beforeData, `${entry.action} must still capture a beforeData snapshot`).not.toBeNull();
      expect(beforeData?.passwordHash).toBeUndefined();
      // Belt and suspenders, same as the reissue-credentials test: the raw
      // hash must not appear anywhere in the persisted row, not just under
      // the expected key name.
      expect(JSON.stringify(beforeData)).not.toContain(passwordHash);
    }
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
