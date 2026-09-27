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
import { waitForAuditLog } from "../../test/waitForAuditLog.js";
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
// Credential issuance itself moved to POST /api/parents/:id/children (see
// parents.test.ts) — a student's login is now issued exactly once, the
// first time a primary-contact parent is linked, never through this
// module directly. What's left here is the admin recovery path.
describe("POST /api/students/:id/reissue-credentials", () => {
  async function studentWithLoginAndPrimaryParent() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("FIA/2026/001");
    const { parent } = await createParent("parent@test.local");
    const linkRes = await request(app)
      .post(`/api/parents/${parent.id}/children`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ studentId: student.id, relationship: "MOTHER", isPrimaryContact: true });
    expect(linkRes.status).toBe(201);
    const notification = await waitForNotification(parent.userId, "Student", student.id);
    const temporaryPassword = /Temporary password: (\S+)\./.exec(notification?.body ?? "")?.[1];
    expect(temporaryPassword, "the issuance notification must contain the temp password").toBeTruthy();
    const issued = await prisma.student.findUniqueOrThrow({ where: { id: student.id } });
    return { adminToken, student: issued, parent, temporaryPassword: temporaryPassword! };
  }

  it("rejects with 409 when the student has no login yet", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const student = await createBareStudent("FIA/2026/002");

    const res = await request(app)
      .post(`/api/students/${student.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(409);
  });

  it("generates a fresh password, resets mustChangePassword, revokes sessions, and sends it to the primary-contact parent", async () => {
    const { adminToken, student, temporaryPassword } = await studentWithLoginAndPrimaryParent();
    const userBefore = await prisma.user.findUniqueOrThrow({ where: { id: student.userId! } });

    // A real session on the original password, to prove reissue revokes it.
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ identifier: userBefore.loginId, password: temporaryPassword });
    expect(loginRes.status).toBe(200);
    const oldRefreshToken = loginRes.body.refreshToken as string;

    const res = await request(app)
      .post(`/api/students/${student.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.temporaryPassword).toBeUndefined();

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: student.userId! } });
    expect(userAfter.passwordHash).not.toBe(userBefore.passwordHash);
    expect(userAfter.mustChangePassword).toBe(true);

    const refreshAttempt = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: oldRefreshToken });
    expect(refreshAttempt.status).toBe(401);
  });

  it("returns the generated password once when every linked parent has been unlinked", async () => {
    const { adminToken, student, parent } = await studentWithLoginAndPrimaryParent();
    const unlinkRes = await request(app)
      .delete(`/api/parents/${parent.id}/children/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlinkRes.status).toBe(204);

    const res = await request(app)
      .post(`/api/students/${student.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.temporaryPassword).toBe("string");
    expect((res.body.temporaryPassword as string).length).toBeGreaterThanOrEqual(8);
  });

  it("never persists the reissued password into the audit log, even on the no-parent-linked branch that returns it", async () => {
    const { adminToken, student, parent } = await studentWithLoginAndPrimaryParent();
    const unlinkRes = await request(app)
      .delete(`/api/parents/${parent.id}/children/${student.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unlinkRes.status).toBe(204);

    const res = await request(app)
      .post(`/api/students/${student.id}/reissue-credentials`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const returnedPassword = res.body.temporaryPassword as string;
    expect(returnedPassword).toBeTruthy();

    const entry = await waitForAuditLog("Student", student.id, "STUDENT_CREDENTIALS_REISSUED");
    expect(entry, "the reissue mutation must still be audited").not.toBeNull();
    const afterData = entry?.afterData as Record<string, unknown> | null;
    expect(afterData?.temporaryPassword).toBeUndefined();
    // Belt and suspenders: the raw generated value must not appear anywhere
    // in the persisted row, not just under the expected key name.
    expect(JSON.stringify(afterData)).not.toContain(returnedPassword);
  });
});

describe("PATCH /api/students/status", () => {
  it("updates the valid ids, reports the invalid ones in failed, and responds 200 not 500", async () => {
    const { token } = await createAdmin("admin@test.local");
    const validA = await createBareStudent("ADM-BULK-001");
    const validB = await createBareStudent("ADM-BULK-002");

    const res = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [validA.id, "does-not-exist", validB.id], status: "INACTIVE" });

    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(expect.arrayContaining([validA.id, validB.id]));
    expect(res.body.updated).toHaveLength(2);
    expect(res.body.failed).toEqual([{ id: "does-not-exist", message: "Student not found" }]);

    const refreshedA = await prisma.student.findUniqueOrThrow({ where: { id: validA.id } });
    expect(refreshedA.status).toBe("INACTIVE");
  });

  // Same shape fix as RESULT_RANKED: this route has no single entity id for
  // the generic auditMutation() middleware to key on (no :id in the path,
  // and the response is a { updated, failed } summary) — without an
  // explicit per-student write, the audit row would land as
  // entityId: "unknown" with the whole batch summary as afterData, and a
  // History panel keyed by student id would never find it.
  it("writes one audit row per student, keyed by that student's own id — not a batch summary", async () => {
    const { token } = await createAdmin("admin@test.local");
    const student = await createBareStudent("ADM-BULK-040");

    const res = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [student.id], status: "WITHDRAWN" });
    expect(res.status).toBe(200);

    const entry = await waitForAuditLog("Student", student.id, "STUDENT_STATUS_BULK_UPDATED");
    expect(entry, "must be keyed by the student's own id, not the batch as a whole").not.toBeNull();
    expect((entry?.beforeData as { status: string } | null)?.status).toBe("ACTIVE");
    expect((entry?.afterData as { status: string } | null)?.status).toBe("WITHDRAWN");
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const student = await createBareStudent("ADM-BULK-010");

    const res = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [student.id], status: "GRADUATED" });

    expect(res.status).toBe(403);
  });

  it("INACTIVE does not close the enrollment; GRADUATED does, and the student stops appearing on the class roster", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-BULK-020");
    const enrollment = await enrollStudent(student.id, klass.id, session.id);

    const inactiveRes = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [student.id], status: "INACTIVE" });
    expect(inactiveRes.status).toBe(200);
    const stillActiveEnrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(stillActiveEnrollment.status).toBe("ACTIVE");
    expect(stillActiveEnrollment.closedAt).toBeNull();

    const rosterBeforeGraduation = await request(app)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${token}`)
      .query({ academicSessionId: session.id });
    expect((rosterBeforeGraduation.body as Array<{ student: { id: string } }>).map((r) => r.student.id)).toContain(
      student.id,
    );

    const graduateRes = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [student.id], status: "GRADUATED" });
    expect(graduateRes.status).toBe(200);

    const closedEnrollment = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(closedEnrollment.status).toBe("GRADUATED");
    expect(closedEnrollment.closedAt).not.toBeNull();
    expect(closedEnrollment.closedByUserId).not.toBeNull();

    const rosterAfterGraduation = await request(app)
      .get(`/api/classes/${klass.id}/students`)
      .set("Authorization", `Bearer ${token}`)
      .query({ academicSessionId: session.id });
    expect(
      (rosterAfterGraduation.body as Array<{ student: { id: string } }>).map((r) => r.student.id),
    ).not.toContain(student.id);
  });

  it("closes every currently-ACTIVE enrollment a student holds, not just one session's", async () => {
    const { token } = await createAdmin("admin@test.local");
    const sessionA = await prisma.academicSession.create({
      data: { name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") },
    });
    const sessionB = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-BULK-030");
    // Simulates the pre-existing gap: promoting a student to a new session
    // has never closed their old session's enrollment (nothing ever wrote
    // to Enrollment.status before this pass) — both are ACTIVE at once.
    const enrollmentA = await enrollStudent(student.id, klass.id, sessionA.id);
    const enrollmentB = await enrollStudent(student.id, klass.id, sessionB.id);

    const res = await request(app)
      .patch("/api/students/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ ids: [student.id], status: "WITHDRAWN" });
    expect(res.status).toBe(200);

    const refreshedA = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentA.id } });
    const refreshedB = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollmentB.id } });
    expect(refreshedA.status).toBe("WITHDRAWN");
    expect(refreshedB.status).toBe("WITHDRAWN");
  });
});

describe("POST /api/students/:id/transfer", () => {
  it("moves the student's current-session enrollment to a different class, in place", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const classA = await createClass("JSS1", "A");
    const classB = await createClass("JSS1", "B");
    const student = await createBareStudent("ADM-XFER-ROUTE-001");
    const enrollment = await enrollStudent(student.id, classA.id, session.id);

    const res = await request(app)
      .post(`/api/students/${student.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: classB.id });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(enrollment.id); // same row, not a new enrollment
    expect(res.body.classId).toBe(classB.id);

    const refreshed = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(refreshed.classId).toBe(classB.id);
    expect(refreshed.status).toBe("ACTIVE"); // untouched — this is a move, not a close
  });

  it("rejects a cross-grade-level target with 400, naming enrollments as the right tool", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const jss1 = await createClass("JSS1", "A");
    const jss2 = await createClass("JSS2", "A");
    const student = await createBareStudent("ADM-XFER-ROUTE-002");
    const enrollment = await enrollStudent(student.id, jss1.id, session.id);

    const res = await request(app)
      .post(`/api/students/${student.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: jss2.id });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("POST /api/students/:id/enrollments");

    const unchanged = await prisma.enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
    expect(unchanged.classId).toBe(jss1.id);
  });

  it("rejects a non-admin caller", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const classA = await createClass("JSS1", "A");
    const classB = await createClass("JSS1", "B");
    const student = await createBareStudent("ADM-XFER-ROUTE-003");
    await enrollStudent(student.id, classA.id, session.id);

    const res = await request(app)
      .post(`/api/students/${student.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: classB.id });

    expect(res.status).toBe(403);
  });

  it("audits the move with the OLD class captured in beforeData", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const classA = await createClass("JSS1", "A");
    const classB = await createClass("JSS1", "B");
    const student = await createBareStudent("ADM-XFER-ROUTE-004");
    await enrollStudent(student.id, classA.id, session.id);

    const res = await request(app)
      .post(`/api/students/${student.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: classB.id });
    expect(res.status).toBe(200);

    const entry = await waitForAuditLog("Student", student.id, "STUDENT_TRANSFERRED");
    expect(entry).not.toBeNull();
    expect((entry?.beforeData as { classId: string } | null)?.classId).toBe(classA.id);
    expect((entry?.afterData as { classId: string } | null)?.classId).toBe(classB.id);
  });
});
