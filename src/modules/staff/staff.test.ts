import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createParent, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

async function createTeacherUserRecord(email: string) {
  return prisma.user.create({
    data: { email, passwordHash: "unused", roles: { create: [{ role: "TEACHER" }] } },
  });
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/staff", () => {
  it("allows an admin to create a staff profile for a TEACHER/ADMIN/BURSAR user", async () => {
    const { token } = await createAdmin("admin@test.local");
    const teacherUser = await createTeacherUserRecord("newteacher@test.local");

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({
        userId: teacherUser.id,
        staffNumber: "STF-001",
        firstName: "Rosalind",
        lastName: "Franklin",
      });

    expect(res.status).toBe(201);
    expect(res.body.staffNumber).toBe("STF-001");
  });

  it("rejects linking to a PARENT-role user", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { user: parentUser } = await createParent("parent@test.local");

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: parentUser.id, staffNumber: "STF-002", firstName: "X", lastName: "Y" });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate staff number", async () => {
    const { token } = await createAdmin("admin@test.local");
    const userA = await createTeacherUserRecord("a@test.local");
    const userB = await createTeacherUserRecord("b@test.local");

    await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: userA.id, staffNumber: "STF-DUP", firstName: "A", lastName: "One" });

    const res = await request(app)
      .post("/api/staff")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: userB.id, staffNumber: "STF-DUP", firstName: "B", lastName: "Two" });

    expect(res.status).toBe(409);
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
