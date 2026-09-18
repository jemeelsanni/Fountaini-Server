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
import { waitForNotification } from "../../test/waitForNotification.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("POST /api/students", () => {
  it("generates FIA/<year>/001 for the first student of a session, and .../002 for the next", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const first = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Ada", lastName: "Lovelace" });
    expect(first.status).toBe(201);
    expect(first.body.admissionNumber).toBe("FIA/2026/001");

    const second = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Grace", lastName: "Hopper" });
    expect(second.status).toBe(201);
    expect(second.body.admissionNumber).toBe("FIA/2026/002");
  });

  it("fails with a specific error, not a calendar-year fallback, when no academic session is current", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Ada", lastName: "Lovelace" });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/no academic session is marked current/i);
  });

  it("produces four distinct admission numbers from four concurrent creations, with no unique-constraint collision", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        request(app)
          .post("/api/students")
          .set("Authorization", `Bearer ${token}`)
          .send({ firstName: "Student", lastName: `${i}` }),
      ),
    );

    for (const res of results) {
      expect(res.status).toBe(201);
    }
    const numbers = results.map((r) => r.body.admissionNumber as string);
    expect(new Set(numbers).size).toBe(4);
  });

  it("keeps a student's number after the session rolls over; a student in the new session starts at 001", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const firstSessionStudent = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Ada", lastName: "Lovelace" });
    expect(firstSessionStudent.body.admissionNumber).toBe("FIA/2026/001");

    // Roll over to a new current session — createCurrentAcademicSession
    // always hardcodes a 2026 startDate regardless of name, so the new
    // session is created directly here with a genuinely later startDate.
    await prisma.academicSession.updateMany({ data: { isCurrent: false } });
    await prisma.academicSession.create({
      data: {
        name: "2027/2028",
        startDate: new Date("2027-09-01"),
        endDate: new Date("2028-07-31"),
        isCurrent: true,
      },
    });

    const newSessionStudent = await request(app)
      .post("/api/students")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Grace", lastName: "Hopper" });
    expect(newSessionStudent.body.admissionNumber).toBe("FIA/2027/001");

    // The first student's number is permanent — unaffected by the rollover.
    const refreshed = await prisma.student.findUniqueOrThrow({
      where: { id: firstSessionStudent.body.id as string },
    });
    expect(refreshed.admissionNumber).toBe("FIA/2026/001");
  });

  describe("explicit admissionNumber override", () => {
    it("accepts a correctly-formatted override and registers it against the counter", async () => {
      const { token } = await createAdmin("admin@test.local");
      await createCurrentAcademicSession("2026/2027");

      const res = await request(app)
        .post("/api/students")
        .set("Authorization", `Bearer ${token}`)
        .send({ admissionNumber: "FIA/2019/050", firstName: "Legacy", lastName: "Import" });
      expect(res.status).toBe(201);
      expect(res.body.admissionNumber).toBe("FIA/2019/050");

      // The counter is bumped so a later generated number for that same
      // prefix-year never collides with the imported one.
      const nextGenerated = await request(app)
        .post("/api/students")
        .set("Authorization", `Bearer ${token}`)
        .send({ admissionNumber: "FIA/2019/049", firstName: "Also", lastName: "Legacy" });
      expect(nextGenerated.status).toBe(201);

      const counter = await prisma.identifierCounter.findUniqueOrThrow({ where: { prefix: "FIA/2019" } });
      expect(counter.lastValue).toBeGreaterThanOrEqual(50);
    });

    it("rejects a duplicate override with 409", async () => {
      const { token } = await createAdmin("admin@test.local");
      await createCurrentAcademicSession("2026/2027");
      await createBareStudent("FIA/2019/050");

      const res = await request(app)
        .post("/api/students")
        .set("Authorization", `Bearer ${token}`)
        .send({ admissionNumber: "FIA/2019/050", firstName: "Ada", lastName: "Lovelace" });

      expect(res.status).toBe(409);
    });

    it("rejects a malformed override", async () => {
      const { token } = await createAdmin("admin@test.local");
      await createCurrentAcademicSession("2026/2027");

      const res = await request(app)
        .post("/api/students")
        .set("Authorization", `Bearer ${token}`)
        .send({ admissionNumber: "ADM-001", firstName: "Ada", lastName: "Lovelace" });

      expect(res.status).toBe(400);
    });

    it("registering an override never requires a current academic session — it doesn't need today's year", async () => {
      const { token } = await createAdmin("admin@test.local");

      const res = await request(app)
        .post("/api/students")
        .set("Authorization", `Bearer ${token}`)
        .send({ admissionNumber: "FIA/2019/050", firstName: "Legacy", lastName: "Import" });

      expect(res.status).toBe(201);
    });
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

// This block replaces Fix 6 from the previous batch ("attaching userId to
// an existing student"). issueLogin: true replaced the userId field on
// PATCH /api/students/:id (see the report: POST /api/users can no longer
// hand over an arbitrary pre-existing user to attach, since a student's
// loginId must be derived from THEIR OWN admissionNumber, which only
// exists once the Student row already does). Two of the original four
// tests survive, adapted to the new shape; the other two ("target user
// already linked to a different student", "user that doesn't hold the
// STUDENT role") are structurally impossible now — there is no external
// user being validated anymore — and are replaced below with coverage of
// issueLogin's own actual behavior (delivery destination, and the
// no-destination fallback) rather than silently dropped.
describe("PATCH /api/students/:id — issueLogin", () => {
  it("issues a login when the student has none yet, deriving loginId from admissionNumber", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issueLogin: true });

    expect(res.status).toBe(200);
    expect(res.body.userId).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId as string } });
    expect(user.loginId).toBe("ADM-001");
    expect(user.mustChangePassword).toBe(true);
  });

  it("rejects with 409 when the student already has a linked user", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");
    await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issueLogin: true });

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issueLogin: true });

    expect(res.status).toBe(409);
  });

  it("delivers credentials to the primary-contact parent when the student has no email of their own", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");
    const { parent } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { studentId: student.id, parentId: parent.id, relationship: "MOTHER", isPrimaryContact: true },
    });

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issueLogin: true });
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toBeUndefined();

    const notification = await waitForNotification(parent.userId, "Student", student.id);
    expect(notification).not.toBeNull();
    expect(notification?.type).toBe("CREDENTIALS_ISSUED");
  });

  it("returns the generated password once when there is no email and no linked parent", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-001");

    const res = await request(app)
      .patch(`/api/students/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ issueLogin: true });

    expect(res.status).toBe(200);
    expect(typeof res.body.temporaryPassword).toBe("string");
    expect((res.body.temporaryPassword as string).length).toBeGreaterThanOrEqual(8);
  });
});
