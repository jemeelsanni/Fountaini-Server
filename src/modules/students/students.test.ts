import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createAssignment,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createSubject,
  createTeacher,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

async function createStudentUserRecord(email: string) {
  const passwordHash = "unused";
  return prisma.user.create({ data: { email, passwordHash, roles: { create: [{ role: "STUDENT" }] } } });
}

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

describe("GET /api/students/:id/parents", () => {
  it("admin and the student's assigned teacher can read it; an unlinked parent cannot", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const { staff, token: teacherToken } = await createTeacher("teacher@test.local");
    await createAssignment(klass.id, subject.id, staff.id, session.id);

    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const { parent } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" },
    });
    const { token: unlinkedParentToken } = await createParent("unlinked-parent@test.local");

    const asAdmin = await request(app)
      .get(`/api/students/${student.id}/parents`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toHaveLength(1);
    expect(asAdmin.body[0].parentId).toBe(parent.id);

    const asTeacher = await request(app)
      .get(`/api/students/${student.id}/parents`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(asTeacher.status).toBe(200);

    const asUnlinkedParent = await request(app)
      .get(`/api/students/${student.id}/parents`)
      .set("Authorization", `Bearer ${unlinkedParentToken}`);
    expect(asUnlinkedParent.status).toBe(403);
  });
});

describe("PATCH /api/students/:id — attaching userId to an existing student", () => {
  it("attaches a userId when currently null", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");
    const user = await createStudentUserRecord("newlogin@test.local");

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
  });

  it("rejects with 409 when the student already has a linked user", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const firstUser = await createStudentUserRecord("first@test.local");
    const student = await createBareStudent("ADM-001");
    await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: firstUser.id });

    const secondUser = await createStudentUserRecord("second@test.local");
    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: secondUser.id });

    expect(res.status).toBe(409);
  });

  it("rejects with 409 when the target user is already linked to a different student", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const user = await createStudentUserRecord("shared@test.local");
    const firstStudent = await createBareStudent("ADM-001");
    await request(app)
      .patch(`/api/students/${firstStudent.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id });

    const secondStudent = await createBareStudent("ADM-002");
    const res = await request(app)
      .patch(`/api/students/${secondStudent.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: user.id });

    expect(res.status).toBe(409);
  });

  it("rejects a user that doesn't hold the STUDENT role", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");
    const nonStudentUser = await prisma.user.create({
      data: { email: "notstudent@test.local", passwordHash: "unused", roles: { create: [{ role: "TEACHER" }] } },
    });

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ userId: nonStudentUser.id });

    expect(res.status).toBe(400);
  });
});
