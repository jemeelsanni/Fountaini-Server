import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAssessmentComponent,
  createAssignment,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

async function setupClassroom() {
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const klass = await createClass("JSS1", "A");
  const subject = await createSubject("Mathematics", "MTH");
  const ca1 = await createAssessmentComponent(session.id, "CA1", "CA", 20, 1);
  const exam = await createAssessmentComponent(session.id, "EXAM", "EXAM", 80, 2);
  return { session, term, klass, subject, ca1, exam };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("GET .../students (roster)", () => {
  // Who can call this route (assigned teacher vs. an unassigned one) is
  // covered by the auth matrix (src/authorization/authMatrix.data.ts) — that
  // exact "unassigned teacher" case is the one named in the coverage audit.
  it("returns the enrolled students for the assignment's class", async () => {
    const { session, klass, subject } = await setupClassroom();
    const { staff: teacherA, token: tokenA } = await createTeacher("teacher-a@test.local");
    const assignment = await createAssignment(klass.id, subject.id, teacherA.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const res = await request(app)
      .get(`/api/class-subject-assignments/${assignment.id}/students`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("PUT .../scores (bulk upsert)", () => {
  it("rejects a score above the component's configured maximum", async () => {
    const { session, term, klass, subject, ca1 } = await setupClassroom();
    const { staff, token } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const res = await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id, entries: [{ studentId: student.id, assessmentComponentId: ca1.id, rawScore: 25 }] });

    expect(res.status).toBe(400);
  });

  it("rejects a score for a student not enrolled in the assignment's class", async () => {
    const { session, term, klass, subject, ca1 } = await setupClassroom();
    const { staff, token } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const unenrolledStudent = await createBareStudent("ADM-002");

    const res = await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        termId: term.id,
        entries: [{ studentId: unenrolledStudent.id, assessmentComponentId: ca1.id, rawScore: 15 }],
      });

    expect(res.status).toBe(400);
  });

  it("accepts a valid score within range for an enrolled student", async () => {
    const { session, term, klass, subject, ca1 } = await setupClassroom();
    const { staff, token } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const res = await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id, entries: [{ studentId: student.id, assessmentComponentId: ca1.id, rawScore: 18 }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("POST .../scores/submit", () => {
  it("rejects submission when some students are missing some components", async () => {
    const { session, term, klass, subject, ca1, exam } = await setupClassroom();
    const { staff, token } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    // Only CA1 entered, EXAM missing.
    await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id, entries: [{ studentId: student.id, assessmentComponentId: ca1.id, rawScore: 18 }] });

    const res = await request(app)
      .post(`/api/class-subject-assignments/${assignment.id}/scores/submit`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id });

    expect(res.status).toBe(400);
    void exam; // referenced for setup clarity only
  });

  it("submits, computes the total, and looks up the correct grade band", async () => {
    const { session, term, klass, subject, ca1, exam } = await setupClassroom();
    await prisma.gradingScale
      .create({ data: { academicSessionId: session.id } })
      .then((scale) =>
        prisma.gradeBand.createMany({
          data: [
            { gradingScaleId: scale.id, grade: "A", minScore: 70, maxScore: 100 },
            { gradingScaleId: scale.id, grade: "B", minScore: 50, maxScore: 69.99 },
            { gradingScaleId: scale.id, grade: "F", minScore: 0, maxScore: 49.99 },
          ],
        }),
      );
    const { staff, token } = await createTeacher("teacher@test.local");
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        termId: term.id,
        entries: [
          { studentId: student.id, assessmentComponentId: ca1.id, rawScore: 18 },
          { studentId: student.id, assessmentComponentId: exam.id, rawScore: 60 },
        ],
      });

    const submitRes = await request(app)
      .post(`/api/class-subject-assignments/${assignment.id}/scores/submit`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id });

    expect(submitRes.status).toBe(200);
    expect(submitRes.body).toHaveLength(1);
    // Decimal fields serialize as strings over JSON (precision safety), not numbers.
    expect(Number(submitRes.body[0].totalScore)).toBe(78);
    expect(submitRes.body[0].grade).toBe("A");
    expect(submitRes.body[0].status).toBe("SUBMITTED");

    // Scores are now locked — editing through the bulk-upsert endpoint is rejected.
    const editAttempt = await request(app)
      .put(`/api/class-subject-assignments/${assignment.id}/scores`)
      .set("Authorization", `Bearer ${token}`)
      .send({ termId: term.id, entries: [{ studentId: student.id, assessmentComponentId: ca1.id, rawScore: 19 }] });
    expect(editAttempt.status).toBe(409);
  });
});
