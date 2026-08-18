import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
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

describe("GET /api/surahs", () => {
  it("returns all 114 surahs in order", async () => {
    const { token } = await createAdmin("admin@test.local");

    const res = await request(app).get("/api/surahs").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(114);
    expect(res.body[0].name).toBe("Al-Fatihah");
    expect(res.body[113].name).toBe("An-Nas");
  });
});

describe("POST /api/madrassah-progress", () => {
  it("lets a teacher record progress against a real surah", async () => {
    const { staff, token } = await createTeacher("instructor@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const student = await createBareStudent("ADM-001");
    const fatihah = await prisma.surah.findUniqueOrThrow({ where: { number: 1 } });

    const res = await request(app)
      .post("/api/madrassah-progress")
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentId: student.id,
        academicSessionId: session.id,
        termId: term.id,
        surahId: fatihah.id,
        ayahFrom: 1,
        ayahTo: 7,
        progressType: "MEMORIZATION",
        status: "COMPLETED",
        generalNotes: "Recited fluently with correct tajweed",
      });

    expect(res.status).toBe(201);
    expect(res.body.staffId).toBe(staff.id);
    expect(res.body.status).toBe("COMPLETED");
  });

  it("rejects a nonexistent surah", async () => {
    const { token } = await createTeacher("instructor@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const student = await createBareStudent("ADM-001");

    const res = await request(app)
      .post("/api/madrassah-progress")
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentId: student.id,
        academicSessionId: session.id,
        termId: term.id,
        surahId: "does-not-exist",
        progressType: "MEMORIZATION",
      });

    expect(res.status).toBe(404);
  });

  it("allows recording juz-based progress without a specific surah", async () => {
    const { token } = await createTeacher("instructor@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const student = await createBareStudent("ADM-001");

    const res = await request(app)
      .post("/api/madrassah-progress")
      .set("Authorization", `Bearer ${token}`)
      .send({
        studentId: student.id,
        academicSessionId: session.id,
        termId: term.id,
        juzNumber: 1,
        progressType: "REVISION",
      });

    expect(res.status).toBe(201);
    expect(res.body.juzNumber).toBe(1);
    expect(res.body.surahId).toBeNull();
  });
});

describe("GET /api/students/:id/madrassah-progress", () => {
  // Who can read this route (linked parent/own student/assigned teacher vs.
  // stranger) is covered by the auth matrix
  // (src/authorization/authMatrix.data.ts). This test only checks content.
  it("returns the student's progress records", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { staff } = await createTeacher("instructor@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("Madrassah 1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    await prisma.madrassahProgress.create({
      data: {
        studentId: student.id,
        staffId: staff.id,
        academicSessionId: session.id,
        termId: term.id,
        progressType: "MEMORIZATION",
        status: "IN_PROGRESS",
      },
    });

    const res = await request(app)
      .get(`/api/students/${student.id}/madrassah-progress`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});
