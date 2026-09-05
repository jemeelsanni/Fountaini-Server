import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
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

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

async function setupRatingsWorld() {
  const { token: adminToken } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const klass = await createClass("JSS1", "A");
  const student = await createBareStudent("ADM-001");
  const enrollment = await enrollStudent(student.id, klass.id, session.id);

  const { staff: formTeacherStaff, token: formTeacherToken } = await createTeacher("form-teacher@test.local");
  await prisma.classFormTeacher.create({
    data: { classId: klass.id, teacherId: formTeacherStaff.id, academicSessionId: session.id },
  });

  // A SUBJECT teacher assigned to this exact class — the negative case that
  // proves canWriteClassRatings checks the form-teacher assignment
  // specifically, mirroring canWriteClassTeacherComment's own test.
  const subject = await createSubject("Mathematics", "MTH");
  const { staff: subjectTeacherStaff, token: subjectTeacherToken } = await createTeacher("subject-teacher@test.local");
  await prisma.classSubjectAssignment.create({
    data: { classId: klass.id, subjectId: subject.id, teacherId: subjectTeacherStaff.id, academicSessionId: session.id },
  });

  const traitRes = await request(app)
    .post(`/api/academic-sessions/${session.id}/traits`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ category: "AFFECTIVE", name: "Punctuality", order: 1 });

  const result = await prisma.result.create({
    data: { studentId: student.id, enrollmentId: enrollment.id, termId: term.id, status: "DRAFT" },
  });

  return {
    adminToken,
    session,
    term,
    klass,
    student,
    formTeacherToken,
    subjectTeacherToken,
    traitId: traitRes.body.id as string,
    result,
  };
}

describe("PUT /api/classes/:id/results/:termId/ratings", () => {
  it("lets the form teacher write ratings, but denies a subject teacher assigned to the same class", async () => {
    const world = await setupRatingsWorld();

    const asFormTeacher = await request(app)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 5 }] });
    expect(asFormTeacher.status).toBe(200);
    expect(asFormTeacher.body).toHaveLength(1);
    expect(asFormTeacher.body[0].value).toBe(5);
    expect(asFormTeacher.body[0].trait.name).toBe("Punctuality");

    const asSubjectTeacher = await request(app)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.subjectTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 3 }] });
    expect(asSubjectTeacher.status).toBe(403);
  });

  it("rejects writing ratings once the student's result for this term is FINALIZED", async () => {
    const world = await setupRatingsWorld();

    await request(app)
      .post(`/api/results/${world.result.id}/finalize`)
      .set("Authorization", `Bearer ${world.adminToken}`);

    const res = await request(app)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 4 }] });
    expect(res.status).toBe(409);

    const ratingRows = await prisma.rating.findMany({ where: { studentId: world.student.id, termId: world.term.id } });
    expect(ratingRows).toHaveLength(0);
  });

  it("appears on GET /api/results/:studentId/:termId once written", async () => {
    const world = await setupRatingsWorld();

    await request(app)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 5 }] });

    await request(app)
      .post(`/api/results/${world.result.id}/finalize`)
      .set("Authorization", `Bearer ${world.adminToken}`);

    const res = await request(app)
      .get(`/api/results/${world.student.id}/${world.term.id}`)
      .set("Authorization", `Bearer ${world.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ratings).toHaveLength(1);
    expect(res.body.ratings[0].value).toBe(5);
    expect(res.body.ratings[0].trait.name).toBe("Punctuality");
    expect(res.body.ratings[0].trait.category).toBe("AFFECTIVE");
  });
});

describe("GET /api/rating-scale", () => {
  it("lists the fixed 5-point scale, ordered 5 to 1 (seed data)", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    for (const level of [
      { value: 5, label: "Excellent" },
      { value: 4, label: "Very Good" },
      { value: 3, label: "Good" },
      { value: 2, label: "Fair" },
      { value: 1, label: "Poor" },
    ]) {
      await prisma.ratingScaleLevel.upsert({ where: { value: level.value }, update: {}, create: level });
    }

    const res = await request(app).get("/api/rating-scale").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((l: { value: number }) => l.value)).toEqual([5, 4, 3, 2, 1]);
  });
});
