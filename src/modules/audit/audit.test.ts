import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("admin mutation auditing", () => {
  it("records an audit entry when an admin creates a class, with the actor and new data", async () => {
    const { token, user } = await createAdmin("admin@test.local");

    const res = await request(app)
      .post("/api/classes")
      .set("Authorization", `Bearer ${token}`)
      .send({ gradeName: "JSS1", arm: "A", order: 1 });
    expect(res.status).toBe(201);

    const entry = await waitForAuditLog("Class", res.body.id as string);
    expect(entry).not.toBeNull();
    expect(entry?.action).toBe("CLASS_CREATED");
    expect(entry?.actorUserId).toBe(user.id);
    expect(entry?.actorRoles).toEqual(["ADMIN"]);
    expect((entry?.afterData as { gradeName?: string } | null)?.gradeName).toBe("JSS1");
  });

  it("records an audit entry for a 204 route (no response body) using the route param id", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { user: teacherUser } = await createTeacher("teacher@test.local");

    const deactivateRes = await request(app)
      .post(`/api/users/${teacherUser.id}/deactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(deactivateRes.status).toBe(200);

    const entry = await waitForAuditLog("User", teacherUser.id);
    expect(entry).not.toBeNull();
    expect(entry?.action).toBe("USER_DEACTIVATED");
  });

  it("does not record an audit entry for a failed (4xx) mutation attempt", async () => {
    const { token } = await createTeacher("teacher@test.local");

    const res = await request(app)
      .post("/api/classes")
      .set("Authorization", `Bearer ${token}`)
      .send({ gradeName: "SS3", order: 1 });
    expect(res.status).toBe(403);

    // Give any (incorrect) write a moment to land, then assert it didn't.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const count = await prisma.auditLog.count({ where: { entityType: "Class" } });
    expect(count).toBe(0);
  });

  it("GET /api/audit-log returns recorded entries", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");

    const createRes = await request(app)
      .post("/api/subjects")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Mathematics", code: "MTH" });
    await waitForAuditLog("Subject", createRes.body.id as string);

    const allowed = await request(app).get("/api/audit-log").set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.length).toBeGreaterThan(0);
  });
});
