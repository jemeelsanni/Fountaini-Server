import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createCurrentAcademicSession, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForNotification } from "../../test/waitForNotification.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

// This block replaces the previous batch's "linking to a PARENT-role user"
// and "userId"-based tests — POST /api/staff no longer links a
// pre-existing user (see the report: it now creates the User atomically,
// choosing its role directly via an enum that excludes PARENT/STUDENT at
// the schema level, so "wrong role" is no longer a reachable business-
// logic case, just an ordinary 400 on an invalid enum value).
describe("POST /api/staff", () => {
  it("creates a staff profile with a generated staff number and an atomically-created login", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "TEACHER", email: "rosalind@test.local", firstName: "Rosalind", lastName: "Franklin" });

    expect(res.status).toBe(201);
    expect(res.body.staffNumber).toBe("FIA/ST2026/001");
    expect(res.body.temporaryPassword).toBeUndefined();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId as string } });
    expect(user.loginId).toBe("FIA/ST2026/001");
    expect(user.email).toBe("rosalind@test.local");
    expect(user.mustChangePassword).toBe(true);

    const notification = await waitForNotification(user.id, "Staff", res.body.id as string);
    expect(notification).not.toBeNull();
    expect(notification?.type).toBe("CREDENTIALS_ISSUED");
  });

  it("rejects PARENT/STUDENT as a role — every staff record is ADMIN, TEACHER, or BURSAR", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "PARENT", email: "x@test.local", firstName: "X", lastName: "Y" });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate email with 409", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const first = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "TEACHER", email: "dupe@test.local", firstName: "A", lastName: "One" });
    await waitForNotification(first.body.userId as string, "Staff", first.body.id as string);

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "BURSAR", email: "dupe@test.local", firstName: "B", lastName: "Two" });

    expect(res.status).toBe(409);
  });

  it("rejects a duplicate staffNumber override with 409", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const first = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "TEACHER", email: "a@test.local", staffNumber: "FIA/ST2019/010", firstName: "A", lastName: "One" });
    await waitForNotification(first.body.userId as string, "Staff", first.body.id as string);

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "TEACHER", email: "b@test.local", staffNumber: "FIA/ST2019/010", firstName: "B", lastName: "Two" });

    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/staff/:id — staffNumber sync", () => {
  it("changing staffNumber updates the linked User.loginId in the same transaction", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");

    const res = await request(app)
      .patch(`/api/staff/${staff.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ staffNumber: "FIA/ST2026/099" });
    expect(res.status).toBe(200);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    expect(user.loginId).toBe("FIA/ST2026/099");
  });
});

// Who can read GET /api/staff/:id (self/admin vs. a colleague) is covered by
// the auth matrix (src/authorization/authMatrix.data.ts).
describe("GET /api/staff/:id", () => {
  it("lets an admin read any staff profile", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");

    const res = await request(app).get(`/api/staff/${staff.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
