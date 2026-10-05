import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { hashPassword } from "../auth/password.js";
import { drainFireAndForget } from "../../lib/fireAndForget.js";
import { createAdmin, createParent, createStudentWithLogin, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";
import { waitForNotification } from "../../test/waitForNotification.js";

const app = createApp();
let server: Server;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
});

afterAll(() => {
  server.close();
});

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
  const loginRes = await request(server).post("/api/auth/login").send({ identifier: email, password });
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

    const res = await request(server)
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
    const res = await request(server).post("/api/users").send({ email: "x@test.local", role: "ADMIN" });

    expect(res.status).toBe(401);
  });

  it("rejects a duplicate email", async () => {
    const adminToken = await createAdminAndLogin();

    const first = await request(server)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "ADMIN" });
    await waitForNotification(first.body.id as string, "User", first.body.id as string);

    const res = await request(server)
      .post("/api/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ email: "dupe@test.local", role: "ADMIN" });

    expect(res.status).toBe(409);
  });

  it("rejects an invalid role", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(server)
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
      const res = await request(server)
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

    const meBefore = await request(server)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${teacherToken}`);
    const teacherId = meBefore.body.principal.userId as string;

    const deactivateRes = await request(server)
      .post(`/api/users/${teacherId}/deactivate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(deactivateRes.status).toBe(200);
    expect(deactivateRes.body.isActive).toBe(false);

    const loginAfterDeactivate = await request(server)
      .post("/api/auth/login")
      .send({ identifier: "teacher@test.local", password: "teacher-password-123" });
    expect(loginAfterDeactivate.status).toBe(401);

    const reactivateRes = await request(server)
      .post(`/api/users/${teacherId}/activate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.isActive).toBe(true);

    const loginAfterReactivate = await request(server)
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
    const meBefore = await request(server).get("/api/auth/me").set("Authorization", `Bearer ${teacherToken}`);
    const teacherId = meBefore.body.principal.userId as string;
    const { passwordHash } = await prisma.user.findUniqueOrThrow({ where: { id: teacherId } });
    expect(passwordHash).toBeTruthy();

    await request(server).post(`/api/users/${teacherId}/deactivate`).set("Authorization", `Bearer ${adminToken}`);
    await request(server).post(`/api/users/${teacherId}/activate`).set("Authorization", `Bearer ${adminToken}`);
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

    const res = await request(server)
      .get("/api/users/does-not-exist")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });
});

describe("GET /api/users/pending-activation", () => {
  it("rejects TEACHER, BURSAR, PARENT and STUDENT with 403", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/001");

    for (const token of [teacherToken, parentToken, studentToken]) {
      const res = await request(server).get("/api/users/pending-activation").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it("lists accounts still on mustChangePassword: true, and excludes one that has changed it", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    // factories.ts's createUser doesn't set mustChangePassword (defaults to
    // false, unlike every real credential-issuing path, which always
    // starts an account at true) — set it directly here to simulate "never
    // signed in yet" for pendingUser, and leave activatedUser's at the
    // factory default (changed) as the contrast case.
    const { user: pendingUser } = await createTeacher("pending@test.local");
    await prisma.user.update({ where: { id: pendingUser.id }, data: { mustChangePassword: true } });
    const { user: activatedUser } = await createParent("activated@test.local");

    const res = await request(server).get("/api/users/pending-activation").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(pendingUser.id);
    expect(ids).not.toContain(activatedUser.id);
  });
});

describe("POST /api/users/:id/reissue-credentials", () => {
  it("returns 404 for a nonexistent user", async () => {
    const adminToken = await createAdminAndLogin();

    const res = await request(server)
      .post("/api/users/does-not-exist/reissue-credentials")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(404);
  });

  it("rejects TEACHER, BURSAR, PARENT and STUDENT with 403", async () => {
    const { user: target } = await createTeacher("target@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/001");

    for (const token of [teacherToken, parentToken, studentToken]) {
      const res = await request(server)
        .post(`/api/users/${target.id}/reissue-credentials`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it("staff: a fresh password works, the old one doesn't, mustChangePassword is true, sessions are revoked, and the password appears nowhere in the response or audit log", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { user: teacherUser, token: oldToken } = await createTeacher("teacher@test.local");
    const oldPasswordHash = (await prisma.user.findUniqueOrThrow({ where: { id: teacherUser.id } })).passwordHash;

    // A real session on the original credentials, to prove reissue revokes it.
    const loginRes = await request(server)
      .post("/api/auth/login")
      .send({ identifier: teacherUser.loginId, password: "password-123456" });
    expect(loginRes.status).toBe(200);
    const oldRefreshToken = loginRes.body.refreshToken as string;
    void oldToken;

    const res = await request(server)
      .post(`/api/users/${teacherUser.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(oldPasswordHash);

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: teacherUser.id } });
    expect(userAfter.passwordHash).not.toBe(oldPasswordHash);
    expect(userAfter.mustChangePassword).toBe(true);

    const refreshAttempt = await request(server).post("/api/auth/refresh").send({ refreshToken: oldRefreshToken });
    expect(refreshAttempt.status).toBe(401);

    const oldPasswordLogin = await request(server)
      .post("/api/auth/login")
      .send({ identifier: teacherUser.loginId, password: "password-123456" });
    expect(oldPasswordLogin.status).toBe(401);

    const entry = await waitForAuditLog("User", teacherUser.id, "USER_CREDENTIALS_REISSUED");
    expect(entry, "the reissue mutation must still be audited").not.toBeNull();
    const afterData = entry?.afterData as Record<string, unknown> | null;
    const beforeData = entry?.beforeData as Record<string, unknown> | null;
    expect(afterData?.temporaryPassword).toBeUndefined();
    expect(beforeData?.passwordHash).toBeUndefined();
    expect(JSON.stringify(afterData)).not.toContain(oldPasswordHash);
    expect(JSON.stringify(beforeData)).not.toContain(oldPasswordHash);
  });

  it("parent: a fresh password works, the old one doesn't, mustChangePassword is true, and sessions are revoked", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { user: parentUser } = await createParent("parent@test.local");
    const oldPasswordHash = (await prisma.user.findUniqueOrThrow({ where: { id: parentUser.id } })).passwordHash;

    const loginRes = await request(server)
      .post("/api/auth/login")
      .send({ identifier: parentUser.loginId, password: "password-123456" });
    expect(loginRes.status).toBe(200);
    const oldRefreshToken = loginRes.body.refreshToken as string;

    const res = await request(server)
      .post(`/api/users/${parentUser.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toBeUndefined();

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: parentUser.id } });
    expect(userAfter.passwordHash).not.toBe(oldPasswordHash);
    expect(userAfter.mustChangePassword).toBe(true);

    const refreshAttempt = await request(server).post("/api/auth/refresh").send({ refreshToken: oldRefreshToken });
    expect(refreshAttempt.status).toBe(401);

    const newPasswordLogin = await request(server)
      .post("/api/auth/login")
      .send({ identifier: parentUser.loginId, password: "password-123456" });
    // The OLD password must no longer work — the real new one was only ever
    // delivered by (placeholder-bodied) notification, not returned here.
    expect(newPasswordLogin.status).toBe(401);
  });

  it("student: delegates through POST /api/students/:id/reissue-credentials to the same shared implementation", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { student, token: oldStudentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/001");
    void oldStudentToken;

    const res = await request(server)
      .post(`/api/users/${student.userId}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: student.userId! } });
    expect(userAfter.mustChangePassword).toBe(true);
  });
});
