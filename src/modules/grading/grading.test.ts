import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { createAdmin, createCurrentAcademicSession, createParent, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

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

    const create = await request(app)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });
    expect(create.status).toBe(201);

    const list = await request(app)
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
    await request(app)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 });

    const res = await request(app)
      .get(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("rejects a duplicate component code within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const body = { code: "CA1", name: "First CA", type: "CA", maxScore: 20, order: 1 };

    await request(app)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const res = await request(app)
      .post(`/api/academic-sessions/${session.id}/assessment-components`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });
});

describe("grading scale and bands", () => {
  it("creates a scale, adds bands, and exposes them on GET", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");

    const scaleRes = await request(app)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    expect(scaleRes.status).toBe(201);

    const bandRes = await request(app)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "A", minScore: 70, maxScore: 100, remark: "Excellent" });
    expect(bandRes.status).toBe(201);

    const getRes = await request(app)
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
    await request(app)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${adminToken}`);

    const res = await request(app)
      .get(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
  });

  it("rejects a second grading scale for the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");

    await request(app)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it("rejects a band where maxScore is not greater than minScore", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const scaleRes = await request(app)
      .post(`/api/academic-sessions/${session.id}/grading-scale`)
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .post(`/api/grading-scales/${scaleRes.body.id}/bands`)
      .set("Authorization", `Bearer ${token}`)
      .send({ grade: "F", minScore: 50, maxScore: 40 });

    expect(res.status).toBe(400);
  });
});
