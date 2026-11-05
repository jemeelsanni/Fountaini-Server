import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { computeResultsForClass, finalizeResult } from "./results.service.js";
import {
  createAdmin,
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

/// A student in both a regular class and a Weekday Madrasa group gets two
/// independent report cards: separate results, positions, ratings,
/// attendance days and session rollups — nothing from one leaks into the
/// other.

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

async function setupWorld() {
  const { user: adminUser, token } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const basic = await createClass("Basic 4");
  const madrasa = await prisma.class.create({
    data: { gradeName: "Weekday Madrasa", arm: "Level 1", order: 100, programme: "MADRASSAH" },
  });
  const maths = await createSubject("Mathematics", "MTH");
  const hadith = await prisma.subject.create({ data: { name: "Hadith", code: "ISL-HAD", type: "MADRASSAH" } });
  const { staff: teacher } = await createTeacher("teacher@test.local");
  const mathsAssignment = await createAssignment(basic.id, maths.id, teacher.id, session.id);
  const hadithAssignment = await createAssignment(madrasa.id, hadith.id, teacher.id, session.id);

  // Two students in both programmes, ranked in opposite orders on each card.
  const amina = await createBareStudent("ADM-001", { firstName: "Amina" });
  const bilal = await createBareStudent("ADM-002", { firstName: "Bilal" });
  for (const student of [amina, bilal]) {
    await enrollStudent(student.id, basic.id, session.id);
    await enrollStudent(student.id, madrasa.id, session.id);
  }

  async function submitted(studentId: string, classSubjectAssignmentId: string, totalScore: number) {
    await prisma.subjectResult.create({
      data: { studentId, classSubjectAssignmentId, termId: term.id, totalScore, status: "SUBMITTED" },
    });
  }
  await submitted(amina.id, mathsAssignment.id, 90);
  await submitted(bilal.id, mathsAssignment.id, 50);
  await submitted(amina.id, hadithAssignment.id, 40);
  await submitted(bilal.id, hadithAssignment.id, 80);

  return { adminUser, token, session, term, basic, madrasa, amina, bilal };
}

describe("academic and Islamiyyah results are separate", () => {
  it("lets a student be enrolled in one class per programme, but not two of the same", async () => {
    const { token, session, basic, madrasa } = await setupWorld();
    const student = await createBareStudent("ADM-003");
    const madrasa2 = await prisma.class.create({
      data: { gradeName: "Weekday Madrasa", arm: "Level 2", order: 101, programme: "MADRASSAH" },
    });

    const enrol = (classId: string) =>
      request(server)
        .post(`/api/students/${student.id}/enrollments`)
        .set("Authorization", `Bearer ${token}`)
        .send({ classId, academicSessionId: session.id });

    const academic = await enrol(basic.id);
    const islamiyyah = await enrol(madrasa.id);
    const secondMadrasa = await enrol(madrasa2.id);

    expect(academic.status).toBe(201);
    expect(academic.body).toMatchObject({ programme: "ACADEMIC" });
    expect(islamiyyah.status).toBe(201);
    expect(islamiyyah.body).toMatchObject({ programme: "MADRASSAH" });
    expect(secondMadrasa.status).toBe(409);
  });

  it("computes each class's results from its own programme's subjects only, with separate positions", async () => {
    const { term, basic, madrasa, amina, bilal } = await setupWorld();

    const academic = await computeResultsForClass({ classId: basic.id, termId: term.id });
    const islamiyyah = await computeResultsForClass({ classId: madrasa.id, termId: term.id });

    const byStudent = (rows: typeof academic, studentId: string) => rows.find((r) => r.studentId === studentId);
    expect(academic.every((r) => r.programme === "ACADEMIC")).toBe(true);
    expect(islamiyyah.every((r) => r.programme === "MADRASSAH")).toBe(true);
    expect(Number(byStudent(academic, amina.id)?.totalScore)).toBe(90);
    expect(Number(byStudent(islamiyyah, amina.id)?.totalScore)).toBe(40);
    expect(byStudent(academic, amina.id)?.position).toBe(1);
    expect(byStudent(academic, bilal.id)?.position).toBe(2);
    expect(byStudent(islamiyyah, amina.id)?.position).toBe(2);
    expect(byStudent(islamiyyah, bilal.id)?.position).toBe(1);
    expect(await prisma.result.count({ where: { studentId: amina.id, termId: term.id } })).toBe(2);
  });

  it("returns the requested card from GET /results/:studentId/:termId, defaulting to ACADEMIC", async () => {
    const { token, term, basic, madrasa, amina } = await setupWorld();
    await computeResultsForClass({ classId: basic.id, termId: term.id });
    await computeResultsForClass({ classId: madrasa.id, termId: term.id });

    const url = `/api/results/${amina.id}/${term.id}`;
    const byDefault = await request(server).get(url).set("Authorization", `Bearer ${token}`);
    const islamiyyah = await request(server)
      .get(`${url}?programme=MADRASSAH`)
      .set("Authorization", `Bearer ${token}`);

    expect(byDefault.status).toBe(200);
    expect(byDefault.body).toMatchObject({ programme: "ACADEMIC", totalScore: "90" });
    expect(islamiyyah.status).toBe(200);
    expect(islamiyyah.body).toMatchObject({ programme: "MADRASSAH", totalScore: "40" });
  });

  it("keeps ratings per programme, each gated only by its own card's status", async () => {
    const { adminUser, token, session, term, basic, madrasa, amina } = await setupWorld();
    const trait = await prisma.trait.create({
      data: { academicSessionId: session.id, category: "AFFECTIVE", name: "Punctuality", order: 1 },
    });
    await computeResultsForClass({ classId: basic.id, termId: term.id });
    await computeResultsForClass({ classId: madrasa.id, termId: term.id });
    const academicResult = await prisma.result.findUniqueOrThrow({
      where: { studentId_termId_programme: { studentId: amina.id, termId: term.id, programme: "ACADEMIC" } },
    });
    await finalizeResult(academicResult.id, adminUser.id);

    const rate = (classId: string, value: number) =>
      request(server)
        .put(`/api/classes/${classId}/results/${term.id}/ratings`)
        .set("Authorization", `Bearer ${token}`)
        .send({ entries: [{ studentId: amina.id, traitId: trait.id, value }] });

    // The academic card is finalized, so its ratings are locked — but the
    // Islamiyyah card is still DRAFT and its own form teacher can rate.
    expect((await rate(basic.id, 5)).status).toBe(409);
    expect((await rate(madrasa.id, 3)).status).toBe(200);

    const islamiyyah = await request(server)
      .get(`/api/results/${amina.id}/${term.id}?programme=MADRASSAH`)
      .set("Authorization", `Bearer ${token}`);
    const academic = await request(server)
      .get(`/api/results/${amina.id}/${term.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect((islamiyyah.body as { ratings: { value: number }[] }).ratings.map((r) => r.value)).toEqual([3]);
    expect((academic.body as { ratings: unknown[] }).ratings).toEqual([]);
  });

  it("counts only the programme's own attendance days on each card", async () => {
    const { adminUser, session, term, basic, madrasa, amina } = await setupWorld();
    for (const klass of [basic, madrasa]) {
      await prisma.attendanceSession.create({
        data: {
          classId: klass.id,
          academicSessionId: session.id,
          termId: term.id,
          date: new Date("2026-09-10"),
          status: "CLOSED",
          openedByUserId: adminUser.id,
          records: {
            create: { studentId: amina.id, status: "PRESENT", method: "MANUAL", recordedByUserId: adminUser.id },
          },
        },
      });
    }
    await computeResultsForClass({ classId: madrasa.id, termId: term.id });
    const result = await prisma.result.findUniqueOrThrow({
      where: { studentId_termId_programme: { studentId: amina.id, termId: term.id, programme: "MADRASSAH" } },
    });

    const finalized = await finalizeResult(result.id, adminUser.id);

    expect(finalized.daysSchoolOpened).toBe(1);
    expect(finalized.daysPresent).toBe(1);
  });

  it("rolls up session results per programme", async () => {
    const { adminUser, token, session, term, basic, madrasa, amina } = await setupWorld();
    for (const klass of [basic, madrasa]) {
      await computeResultsForClass({ classId: klass.id, termId: term.id });
    }
    for (const result of await prisma.result.findMany({ where: { studentId: amina.id } })) {
      await finalizeResult(result.id, adminUser.id);
    }

    for (const klass of [basic, madrasa]) {
      const res = await request(server)
        .post("/api/session-results/compute")
        .set("Authorization", `Bearer ${token}`)
        .send({ classId: klass.id, academicSessionId: session.id });
      expect(res.status).toBe(200);
    }

    const url = `/api/session-results/${amina.id}/${session.id}`;
    const academic = await request(server).get(url).set("Authorization", `Bearer ${token}`);
    const islamiyyah = await request(server)
      .get(`${url}?programme=MADRASSAH`)
      .set("Authorization", `Bearer ${token}`);
    expect(academic.body).toMatchObject({ programme: "ACADEMIC", averageScore: "90" });
    expect(islamiyyah.body).toMatchObject({ programme: "MADRASSAH", averageScore: "40" });
  });

  it("transfers only the enrollment in the target class's programme", async () => {
    const { token, session, basic, madrasa, amina } = await setupWorld();
    const madrasa2 = await prisma.class.create({
      data: { gradeName: "Weekday Madrasa", arm: "Level 2", order: 101, programme: "MADRASSAH" },
    });

    const res = await request(server)
      .post(`/api/students/${amina.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: madrasa2.id });

    expect(res.status).toBe(200);
    const enrollments = await prisma.enrollment.findMany({
      where: { studentId: amina.id, academicSessionId: session.id },
      orderBy: { programme: "asc" },
    });
    expect(enrollments.map((e) => e.classId)).toEqual([basic.id, madrasa2.id]);
    expect(madrasa.id).not.toBe(madrasa2.id);
  });

  it("lists a student in both programmes once in search, under their regular class", async () => {
    const { token } = await setupWorld();

    const res = await request(server).get("/api/students/search?q=Amina").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ firstName: "Amina", className: "Basic 4" })]);
  });
});
