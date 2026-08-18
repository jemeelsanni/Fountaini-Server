import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBursar, createClass, createSubject, createTeacher } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("academic sessions", () => {
  it("allows an admin to create a session", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");

    const asAdmin = await request(app)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" });
    expect(asAdmin.status).toBe(201);
  });

  it("rejects endDate before startDate", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(app)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "2026/2027", startDate: "2027-07-31", endDate: "2026-09-01" });

    expect(res.status).toBe(400);
  });

  it("rejects a duplicate session name", async () => {
    const { token } = await createAdmin("admin@test.local");
    const body = { name: "2026/2027", startDate: "2026-09-01", endDate: "2027-07-31" };

    await request(app).post("/api/academic-sessions").set("Authorization", `Bearer ${token}`).send(body);
    const res = await request(app)
      .post("/api/academic-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });

  it("set-current clears isCurrent on every other session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const a = await prisma.academicSession.create({
      data: { name: "A", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31"), isCurrent: true },
    });
    const b = await prisma.academicSession.create({
      data: { name: "B", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const res = await request(app)
      .patch(`/api/academic-sessions/${b.id}/set-current`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const refreshedA = await prisma.academicSession.findUniqueOrThrow({ where: { id: a.id } });
    const refreshedB = await prisma.academicSession.findUniqueOrThrow({ where: { id: b.id } });
    expect(refreshedA.isCurrent).toBe(false);
    expect(refreshedB.isCurrent).toBe(true);
  });
});

describe("terms", () => {
  it("rejects a duplicate order within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const session = await createCurrentSessionViaApi(app, token);

    const body = { name: "First Term", order: 1, startDate: "2026-09-01", endDate: "2026-12-15" };
    await request(app)
      .post(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const res = await request(app)
      .post(`/api/academic-sessions/${session.id}/terms`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...body, name: "Also First Term" });

    expect(res.status).toBe(409);
  });

  it("set-current only clears isCurrent within the same session", async () => {
    const { token } = await createAdmin("admin@test.local");
    const sessionA = await createCurrentSessionViaApi(app, token, "A");
    const sessionB = await createCurrentSessionViaApi(app, token, "B");

    const termA = await prisma.term.create({
      data: {
        academicSessionId: sessionA.id,
        name: "Term A1",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-01"),
        isCurrent: true,
      },
    });
    const termB = await prisma.term.create({
      data: {
        academicSessionId: sessionB.id,
        name: "Term B1",
        order: 1,
        startDate: new Date("2026-09-01"),
        endDate: new Date("2026-12-01"),
        isCurrent: true,
      },
    });
    const termA2 = await prisma.term.create({
      data: {
        academicSessionId: sessionA.id,
        name: "Term A2",
        order: 2,
        startDate: new Date("2027-01-01"),
        endDate: new Date("2027-04-01"),
      },
    });

    const res = await request(app)
      .patch(`/api/terms/${termA2.id}/set-current`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const refreshedTermA = await prisma.term.findUniqueOrThrow({ where: { id: termA.id } });
    const refreshedTermA2 = await prisma.term.findUniqueOrThrow({ where: { id: termA2.id } });
    const refreshedTermB = await prisma.term.findUniqueOrThrow({ where: { id: termB.id } });

    expect(refreshedTermA.isCurrent).toBe(false);
    expect(refreshedTermA2.isCurrent).toBe(true);
    expect(refreshedTermB.isCurrent).toBe(true); // untouched — different session
  });
});

describe("classes and subjects", () => {
  it("rejects a duplicate (gradeName, arm) class", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createClass("JSS1", "A");

    const res = await request(app)
      .post("/api/classes")
      .set("Authorization", `Bearer ${token}`)
      .send({ gradeName: "JSS1", arm: "A", order: 1 });

    expect(res.status).toBe(409);
  });

  it("rejects a duplicate subject code", async () => {
    const { token } = await createAdmin("admin@test.local");
    await createSubject("Mathematics", "MTH");

    const res = await request(app)
      .post("/api/subjects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Maths (again)", code: "MTH" });

    expect(res.status).toBe(409);
  });
});

describe("class-subject-teacher assignments", () => {
  it("assigns a teacher and rejects a non-teaching staff role", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff: teacherStaff } = await createTeacher("teacher@test.local");
    const { staff: bursarStaff } = await createBursar("bursar@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    const validAssignment = await request(app)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        classId: klass.id,
        subjectId: subject.id,
        teacherId: teacherStaff.id,
        academicSessionId: session.id,
      });
    expect(validAssignment.status).toBe(201);

    const bursarAssignment = await request(app)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send({
        classId: klass.id,
        subjectId: subject.id,
        teacherId: bursarStaff.id,
        academicSessionId: session.id,
      });
    expect(bursarAssignment.status).toBe(400);
  });

  it("rejects a duplicate class/subject/session assignment", async () => {
    const { token } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("teacher@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });
    const body = {
      classId: klass.id,
      subjectId: subject.id,
      teacherId: staff.id,
      academicSessionId: session.id,
    };

    await request(app).post("/api/class-subject-assignments").set("Authorization", `Bearer ${token}`).send(body);
    const res = await request(app)
      .post("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(res.status).toBe(409);
  });

  it("scopes a teacher's assignment list to their own assignments regardless of the query param", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { staff: teacherA, token: teacherAToken } = await createTeacher("teacher-a@test.local");
    const { staff: teacherB } = await createTeacher("teacher-b@test.local");
    const klass = await createClass("JSS1", "A");
    const subject = await createSubject("Mathematics", "MTH");
    const session = await prisma.academicSession.create({
      data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31") },
    });

    await prisma.classSubjectAssignment.create({
      data: { classId: klass.id, subjectId: subject.id, teacherId: teacherA.id, academicSessionId: session.id },
    });
    const subject2 = await createSubject("English", "ENG");
    await prisma.classSubjectAssignment.create({
      data: { classId: klass.id, subjectId: subject2.id, teacherId: teacherB.id, academicSessionId: session.id },
    });

    // Teacher A tries to peek at teacher B's assignments via the query param.
    const res = await request(app)
      .get(`/api/class-subject-assignments?teacherId=${teacherB.id}`)
      .set("Authorization", `Bearer ${teacherAToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].teacherId).toBe(teacherA.id);

    // Sanity: admin sees everything.
    const asAdmin = await request(app)
      .get("/api/class-subject-assignments")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(asAdmin.body).toHaveLength(2);
  });
});

async function createCurrentSessionViaApi(appInstance: ReturnType<typeof createApp>, token: string, name = "S") {
  const res = await request(appInstance)
    .post("/api/academic-sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `${name}-${Date.now()}-${Math.random()}`, startDate: "2026-09-01", endDate: "2027-07-31" });
  return res.body as { id: string };
}
