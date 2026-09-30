import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForAuditLog } from "../../test/waitForAuditLog.js";

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

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("admin mutation auditing", () => {
  it("records an audit entry when an admin creates a class, with the actor and new data", async () => {
    const { token, user } = await createAdmin("admin@test.local");

    const res = await request(server)
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

    const deactivateRes = await request(server)
      .post(`/api/users/${teacherUser.id}/deactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(deactivateRes.status).toBe(200);

    const entry = await waitForAuditLog("User", teacherUser.id);
    expect(entry).not.toBeNull();
    expect(entry?.action).toBe("USER_DEACTIVATED");
  });

  it("does not record an audit entry for a failed (4xx) mutation attempt", async () => {
    const { token } = await createTeacher("teacher@test.local");

    const res = await request(server)
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

    const createRes = await request(server)
      .post("/api/subjects")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Mathematics", code: "MTH" });
    await waitForAuditLog("Subject", createRes.body.id as string);

    const allowed = await request(server).get("/api/audit-log").set("Authorization", `Bearer ${adminToken}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.length).toBeGreaterThan(0);
  });

  // Regression test for a real bug found while building the fee-payments
  // dashboard: validate.ts used to write the parsed query back onto
  // req.query via Object.assign, but Express 5's req.query is a getter that
  // re-derives a fresh object from req.url on every access — the mutation
  // never actually reached the controller, so listAuditLogQuerySchema's
  // limit: .default(100) was silently never applied, and this route
  // returned every row, unbounded, on every call with no ?limit. Fixed by
  // having validate() store the parsed result on req.validatedQuery instead
  // (a plain, real property) and reading that here rather than req.query.
  it("defaults to a 100-row limit when none is given, not unlimited", async () => {
    const { token: adminToken, user } = await createAdmin("admin@test.local");
    await prisma.auditLog.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        actorUserId: user.id,
        actorRoles: ["ADMIN" as const],
        action: "TEST_ACTION",
        entityType: "Test",
        entityId: `entity-${i}`,
      })),
    });

    const res = await request(server).get("/api/audit-log").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(100);
  });

  // The ceiling (listAuditLogQuerySchema's .max(500)) is a validation rule,
  // not a transform — it was never actually reachable through the
  // req.query bug above: safeParse()/rejection reads the real, current
  // req.query directly, at the point validate() runs, independent of the
  // broken write-back that only affected what the CONTROLLER saw
  // afterward. Verified directly rather than assumed: an explicit
  // over-ceiling value was already rejected before today's fix, and still
  // is now.
  it("rejects an explicit limit above the 500-row ceiling with 400, not a truncated 500", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");

    const res = await request(server)
      .get("/api/audit-log?limit=501")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(400);
  });

  it("accepts an explicit limit at the 500-row ceiling", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");

    const res = await request(server)
      .get("/api/audit-log?limit=500")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });
});
