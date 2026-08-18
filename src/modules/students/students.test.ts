import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import {
  createAdmin,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/students", () => {
  it("allows an admin to create a student", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-001", firstName: "Ada", lastName: "Lovelace" });

    expect(res.status).toBe(201);
    expect(res.body.admissionNumber).toBe("ADM-001");
  });

  it("rejects a duplicate admission number", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createBareStudent("ADM-001");

    const res = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ admissionNumber: "ADM-001", firstName: "Ada", lastName: "Lovelace" });

    expect(res.status).toBe(409);
  });
});

// Who can read GET /api/students/:id (self/linked parent/assigned teacher vs.
// stranger/unlinked parent/unassigned teacher) is covered by the auth matrix
// (src/authorization/authMatrix.data.ts).
describe("GET /api/students/:id", () => {
  it("returns 404 for a nonexistent student even for an admin", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(app)
      .get("/api/students/does-not-exist")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/students/:id/enrollments", () => {
  it("enrolls a student and rejects a duplicate enrollment for the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-500");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");

    const first = await request(app)
      .post(`/api/students/${student.id}/enrollments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, academicSessionId: session.id });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/students/${student.id}/enrollments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: klass.id, academicSessionId: session.id });
    expect(second.status).toBe(409);
  });
});
