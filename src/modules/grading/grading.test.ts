import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createAssignment,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
  createSubject,
  createTeacher,
  createTermForSession,
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

describe("assessment components", () => {
  it("allows an admin to define components and a teacher to view them", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const session = await createCurrentAcademicSession("2026/2027");

    const create = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });
    expect(create.status).toBe(201);

    const list = await request(server)
      .get(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  // The actual fix: this route was ADMIN+TEACHER-only before this pass,
  // which left a PARENT unable to read assessment-component definitions
  // even though the sibling reference-data routes (sessions, terms,
  // grading-scale) were already open to every authenticated role. Fails
  // before the requireRole widening in grading.routes.ts, passes after.
  it("is readable by a PARENT, not just ADMIN/TEACHER", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });

    const res = await request(server)
      .get(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects a duplicate component code within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const body = { code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 };

    await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const res = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });
});

describe("PATCH/DELETE /api/assessment-components/:id", () => {
  it("updates a field, leaving the rest untouched, and carries no warning when the session's total stays 100", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const ca = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });
    await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "EXAM", name: "Exam", type: "EXAM", maxScore: 80, order: 2 });

    const res = await request(server)
      .patch(`/api/assessment-components/${ca.body.id as string}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed CA" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed CA");
    expect(res.body.code).toBe("CA1"); // untouched
    expect(res.body.warning).toBeUndefined();
  });

  // The compute path (scores.service.ts's submitScores) sums raw scores
  // across every component and compares the total directly against grade
  // bands calibrated for 0-100 — nothing normalizes it, so a session whose
  // components no longer sum to 100 silently produces an out-of-scale
  // grade on the next submit. The chosen behaviour is a warning, not a
  // rejection (see updateAssessmentComponent's own comment) — this proves
  // the response actually carries it rather than silently accepting the
  // edit.
  it("carries a warning when an edit leaves the session's components summing to something other than 100", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const ca = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });
    await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "EXAM", name: "Exam", type: "EXAM", maxScore: 80, order: 2 });

    const res = await request(server)
      .patch(`/api/assessment-components/${ca.body.id as string}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ maxScore: 30 }); // 30 + 80 = 110, not 100

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/sum to 110/);
  });

  it("deletes a component with no scores, 204", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const create = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });

    const res = await request(server)
      .delete(`/api/assessment-components/${create.body.id as string}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.assessmentComponent.findUnique({ where: { id: create.body.id as string } })).toBeNull();
  });

  it("409s deleting a component with a recorded score, and deletes nothing", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const assignment = await createAssignment(klass.id, subject.id, staff.id, session.id);
    const create = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });
    const { student } = await createStudentWithLogin("scored-student@test.local", "STU-GRD-001");
    await prisma.score.create({
      data: {
        studentId: student.id,
        classSubjectAssignmentId: assignment.id,
        termId: term.id,
        assessmentComponentId: create.body.id as string,
        rawScore: 15,
        enteredByUserId: staff.userId,
      },
    });

    const res = await request(server)
      .delete(`/api/assessment-components/${create.body.id as string}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("1 recorded score");
    expect(await prisma.assessmentComponent.findUnique({ where: { id: create.body.id as string } })).not.toBeNull();
  });

  it("rejects a non-admin caller on both PATCH and DELETE", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const create = await request(server)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });

    const patchRes = await request(server)
      .patch(`/api/assessment-components/${create.body.id as string}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ name: "X" });
    expect(patchRes.status).toBe(403);

    const deleteRes = await request(server)
      .delete(`/api/assessment-components/${create.body.id as string}`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(deleteRes.status).toBe(403);
  });
});

describe("grading scale and bands", () => {
  it("creates a scale, adds bands, and exposes them on GET", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");

    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    expect(scaleRes.status).toBe(201);

    const bandRes = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 70, maxScore: 100, remark: "Excellent" });
    expect(bandRes.status).toBe(201);

    const getRes = await request(server)
      .get(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.bands).toHaveLength(1);
    expect(getRes.body.bands[0].grade).toBe("A");
  });

  // Already open before this pass (requireRole(...ALL_ROLES)) — added
  // coverage for an already-correct path, not a fail-before regression test.
  it("is readable by a PARENT, not just ADMIN", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${adminToken}`);

    const res = await request(server)
      .get(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
  });

  it("rejects a second grading scale for the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");

    await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    const res = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it("rejects a band where maxScore is not greater than minScore", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "F", minScore: 50, maxScore: 40 });

    expect(res.status).toBe(400);
  });

  // Same class of silent failure as the assessment-component non-100-total
  // warning: submitScores' band lookup handles an uncovered score
  // gracefully (grade: null) rather than throwing, on a real report card —
  // and the same reason it can't be blocked per-band (a scale built up one
  // band at a time necessarily has gaps until it's finished) means the fix
  // is a warning, not a rejection.
  it("carries a warning when the scale's bands leave part of 0-100 uncovered after creating a band", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);

    // Only 70-100 covered — 0-69.99 is a gap.
    const res = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 70, maxScore: 100 });

    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/0-69\.99/);
  });

  it("carries no warning once bands fully cover 0-100 with no gaps", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "F", minScore: 0, maxScore: 49.99 });
    await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "B", minScore: 50, maxScore: 69.99 });

    const res = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 70, maxScore: 100 });

    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
  });

  it("carries a warning when updating a band opens up a gap that wasn't there before", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "F", minScore: 0, maxScore: 49.99 });
    const bandB = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "B", minScore: 50, maxScore: 100 });

    // Shrinking B down to 50-79.99 now leaves 80-100 uncovered.
    const res = await request(server)
      .patch(`/api/grade-bands/${bandB.body.id as string}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ maxScore: 79.99 });

    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/80-100/);
  });

  it("rejects creating a band whose range overlaps an existing one", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "B", minScore: 50, maxScore: 69 });

    // 60-79 overlaps the existing 50-69 band in the 60-69 range.
    const res = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 60, maxScore: 79 });

    expect(res.status).toBe(400);
  });
});

describe("PATCH/DELETE /api/grade-bands/:id", () => {
  async function buildScaleWithTwoBands(token: string) {
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(server)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    const bandA = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "B", minScore: 50, maxScore: 69, remark: "Good" });
    const bandB = await request(server)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 70, maxScore: 100 });
    return { scaleId: scaleRes.body.id as string, bandA: bandA.body, bandB: bandB.body };
  }

  it("updates a field, leaving others untouched, and an explicit null clears remark", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { bandA } = await buildScaleWithTwoBands(token);

    const res = await request(server)
      .patch(`/api/grade-bands/${bandA.id as string}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ remark: null });

    expect(res.status).toBe(200);
    expect(res.body.remark).toBeNull();
    expect(res.body.grade).toBe("B"); // untouched
  });

  it("rejects updating a band into a range that overlaps a sibling band — the same check create applies", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { bandA } = await buildScaleWithTwoBands(token);

    // Widening B (50-69) up to 75 now overlaps A's 70-100.
    const res = await request(server)
      .patch(`/api/grade-bands/${bandA.id as string}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ maxScore: 75 });

    expect(res.status).toBe(400);
    const stillOriginal = await prisma.gradeBand.findUniqueOrThrow({ where: { id: bandA.id as string } });
    expect(stillOriginal.maxScore.toNumber()).toBe(69);
  });

  it("deletes a band, 204", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { bandA } = await buildScaleWithTwoBands(token);

    const res = await request(server)
      .delete(`/api/grade-bands/${bandA.id as string}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(await prisma.gradeBand.findUnique({ where: { id: bandA.id as string } })).toBeNull();
  });

  it("rejects a non-admin caller on both PATCH and DELETE", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { bandA } = await buildScaleWithTwoBands(adminToken);

    const patchRes = await request(server)
      .patch(`/api/grade-bands/${bandA.id as string}`)
      .set("Authorization", `Bearer ${teacherToken}`)
      .send({ remark: "X" });
    expect(patchRes.status).toBe(403);

    const deleteRes = await request(server)
      .delete(`/api/grade-bands/${bandA.id as string}`)
      .set("Authorization", `Bearer ${teacherToken}`);
    expect(deleteRes.status).toBe(403);
  });
});
