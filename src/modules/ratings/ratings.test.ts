import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

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

  const traitRes = await request(server)
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

    const asFormTeacher = await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 5 }] });
    expect(asFormTeacher.status).toBe(200);
    expect(asFormTeacher.body).toHaveLength(1);
    expect(asFormTeacher.body[0].value).toBe(5);
    expect(asFormTeacher.body[0].trait.name).toBe("Punctuality");

    const asSubjectTeacher = await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.subjectTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 3 }] });
    expect(asSubjectTeacher.status).toBe(403);
  });

  it("rejects writing ratings once the student's result for this term is FINALIZED", async () => {
    const world = await setupRatingsWorld();

    await request(server)
      .post(`/api/results/${world.result.id}/finalize`)
      .set("Authorization", `Bearer ${world.adminToken}`);

    const res = await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 4 }] });
    expect(res.status).toBe(409);

    const ratingRows = await prisma.rating.findMany({ where: { studentId: world.student.id, termId: world.term.id } });
    expect(ratingRows).toHaveLength(0);
  });

  it("appears on GET /api/results/:studentId/:termId once written", async () => {
    const world = await setupRatingsWorld();

    await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 5 }] });

    await request(server)
      .post(`/api/results/${world.result.id}/finalize`)
      .set("Authorization", `Bearer ${world.adminToken}`);

    const res = await request(server)
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

    const res = await request(server).get("/api/rating-scale").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.map((l: { value: number }) => l.value)).toEqual([5, 4, 3, 2, 1]);
  });
});

describe("PATCH /api/traits/:id", () => {
  it("updates name/order and rejects TEACHER, BURSAR, PARENT and STUDENT", async () => {
    const world = await setupRatingsWorld();

    const res = await request(server)
      .patch(`/api/traits/${world.traitId}`)
      .set("Authorization", `Bearer ${world.adminToken}`)
      .send({ name: "Punctuality and timeliness", order: 2 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Punctuality and timeliness");
    expect(res.body.order).toBe(2);

    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/900");
    for (const token of [world.formTeacherToken, bursarToken, parentToken, studentToken]) {
      const denied = await request(server)
        .patch(`/api/traits/${world.traitId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "x" });
      expect(denied.status).toBe(403);
    }
  });

  it("returns 404 for a nonexistent trait", async () => {
    const { token } = await createAdmin("admin@test.local");
    const res = await request(server)
      .patch("/api/traits/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/traits/:id/deactivate", () => {
  it("deactivates a trait, is idempotent, and rejects TEACHER, BURSAR, PARENT and STUDENT", async () => {
    const world = await setupRatingsWorld();

    const res = await request(server)
      .post(`/api/traits/${world.traitId}/deactivate`)
      .set("Authorization", `Bearer ${world.adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    const again = await request(server)
      .post(`/api/traits/${world.traitId}/deactivate`)
      .set("Authorization", `Bearer ${world.adminToken}`);
    expect(again.status).toBe(200);
    expect(again.body.isActive).toBe(false);

    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/900");
    for (const token of [world.formTeacherToken, bursarToken, parentToken, studentToken]) {
      const denied = await request(server)
        .post(`/api/traits/${world.traitId}/deactivate`)
        .set("Authorization", `Bearer ${token}`);
      expect(denied.status).toBe(403);
    }
  });

  it("stops a deactivated trait from being rated against, without touching ratings already recorded", async () => {
    const world = await setupRatingsWorld();

    const before = await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 4 }] });
    expect(before.status).toBe(200);

    const deactivateRes = await request(server)
      .post(`/api/traits/${world.traitId}/deactivate`)
      .set("Authorization", `Bearer ${world.adminToken}`);
    expect(deactivateRes.status).toBe(200);

    const afterDeactivate = await request(server)
      .put(`/api/classes/${world.klass.id}/results/${world.term.id}/ratings`)
      .set("Authorization", `Bearer ${world.formTeacherToken}`)
      .send({ entries: [{ studentId: world.student.id, traitId: world.traitId, value: 5 }] });
    expect(afterDeactivate.status).toBe(400);

    // The rating recorded before deactivation is untouched.
    const rating = await prisma.rating.findFirstOrThrow({
      where: { studentId: world.student.id, termId: world.term.id, traitId: world.traitId },
    });
    expect(rating.value).toBe(4);
  });
});
