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

/// Every scholar in a regular class gets two results a term: a Western one
/// and an Islamiyyah one. The SUBJECT decides which its scores count
/// towards — Islamiyyah subjects (type MADRASSAH) only ever count towards
/// the Islamiyyah result, everything else (Islamic Studies included) only
/// towards the Western one. The class's Islamiyyah subject teachers run the
/// Islamiyyah card; the form teacher runs the Western one.

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
  const { user: adminUser, token: adminToken } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const jss1 = await createClass("JSS1", "A");

  const maths = await createSubject("Mathematics", "MTH");
  const islamicStudies = await createSubject("Islamic Studies", "IRS");
  const tawheed = await prisma.subject.create({ data: { name: "Tawheed", code: "ISL-TAW", type: "MADRASSAH" } });
  const quran = await prisma.subject.create({
    data: { name: "Qur'an Memorisation", code: "ISL-QUR", type: "MADRASSAH" },
  });

  const formTeacher = await createTeacher("form@test.local");
  const ustadh = await createTeacher("ustadh@test.local");
  await prisma.classFormTeacher.create({
    data: { classId: jss1.id, academicSessionId: session.id, teacherId: formTeacher.staff.id },
  });
  const mathsA = await createAssignment(jss1.id, maths.id, formTeacher.staff.id, session.id);
  const irsA = await createAssignment(jss1.id, islamicStudies.id, formTeacher.staff.id, session.id);
  const tawheedA = await createAssignment(jss1.id, tawheed.id, ustadh.staff.id, session.id);
  const quranA = await createAssignment(jss1.id, quran.id, ustadh.staff.id, session.id);

  const aisha = await createBareStudent("FIA-001", { firstName: "Aisha" });
  const bilal = await createBareStudent("FIA-002", { firstName: "Bilal" });
  for (const student of [aisha, bilal]) {
    await enrollStudent(student.id, jss1.id, session.id);
  }

  async function submitted(studentId: string, classSubjectAssignmentId: string, totalScore: number) {
    await prisma.subjectResult.create({
      data: { studentId, classSubjectAssignmentId, termId: term.id, totalScore, status: "SUBMITTED" },
    });
  }
  // Aisha leads on Western, Bilal on Islamiyyah.
  await submitted(aisha.id, mathsA.id, 90);
  await submitted(aisha.id, irsA.id, 80);
  await submitted(aisha.id, tawheedA.id, 40);
  await submitted(aisha.id, quranA.id, 60);
  await submitted(bilal.id, mathsA.id, 50);
  await submitted(bilal.id, irsA.id, 60);
  await submitted(bilal.id, tawheedA.id, 70);
  await submitted(bilal.id, quranA.id, 90);

  return { adminUser, adminToken, session, term, jss1, formTeacher, ustadh, aisha, bilal };
}

function card(studentId: string, termId: string, programme: "ACADEMIC" | "MADRASSAH") {
  return prisma.result.findUniqueOrThrow({
    where: { studentId_termId_programme: { studentId, termId, programme } },
  });
}

describe("Western and Islamiyyah results in a regular class", () => {
  it("splits each student's subjects by subject type, with separate totals and positions", async () => {
    const { term, jss1, aisha, bilal } = await setupWorld();

    const results = await computeResultsForClass({ classId: jss1.id, termId: term.id });

    expect(results).toHaveLength(4);
    const western = await card(aisha.id, term.id, "ACADEMIC");
    const islamiyyah = await card(aisha.id, term.id, "MADRASSAH");
    // Islamic Studies is a Western subject: 90 + 80.
    expect(Number(western.totalScore)).toBe(170);
    expect(Number(western.averageScore)).toBe(85);
    // Tawheed + Qur'an only: 40 + 60.
    expect(Number(islamiyyah.totalScore)).toBe(100);
    expect(Number(islamiyyah.averageScore)).toBe(50);
    expect(western.position).toBe(1);
    expect(islamiyyah.position).toBe(2);
    expect((await card(bilal.id, term.id, "MADRASSAH")).position).toBe(1);
    expect(islamiyyah.enrollmentId).toBe(western.enrollmentId);
  });

  it("gives a class with no Islamiyyah subject no Islamiyyah result", async () => {
    const { session, term, formTeacher } = await setupWorld();
    const creche = await createClass("Creche");
    const rhymes = await createSubject("Rhymes", "RHY");
    const a = await createAssignment(creche.id, rhymes.id, formTeacher.staff.id, session.id);
    const child = await createBareStudent("FIA-010");
    await enrollStudent(child.id, creche.id, session.id);
    await prisma.subjectResult.create({
      data: { studentId: child.id, classSubjectAssignmentId: a.id, termId: term.id, totalScore: 70, status: "SUBMITTED" },
    });

    const results = await computeResultsForClass({ classId: creche.id, termId: term.id });

    expect(results.map((r) => r.programme)).toEqual(["ACADEMIC"]);
  });

  it("leaves the Islamiyyah card of a student in a Madrasa group to that group", async () => {
    const { session, term, jss1, ustadh, aisha, bilal } = await setupWorld();
    const madrasa = await prisma.class.create({
      data: { gradeName: "Weekday Madrasa", arm: "Level 1", order: 100, programme: "MADRASSAH" },
    });
    const hadith = await prisma.subject.create({ data: { name: "Hadith", code: "ISL-HAD", type: "MADRASSAH" } });
    const hadithA = await createAssignment(madrasa.id, hadith.id, ustadh.staff.id, session.id);
    await enrollStudent(aisha.id, madrasa.id, session.id);
    await prisma.subjectResult.create({
      data: { studentId: aisha.id, classSubjectAssignmentId: hadithA.id, termId: term.id, totalScore: 20, status: "SUBMITTED" },
    });

    const fromClass = await computeResultsForClass({ classId: jss1.id, termId: term.id });
    expect(fromClass.filter((r) => r.programme === "MADRASSAH").map((r) => r.studentId)).toEqual([bilal.id]);

    await computeResultsForClass({ classId: madrasa.id, termId: term.id });
    // Every Islamiyyah subject she took, whichever class taught it: 40 + 60 + 20.
    expect(Number((await card(aisha.id, term.id, "MADRASSAH")).totalScore)).toBe(120);
  });

  it("ranks each card on its own once every student on it is finalized", async () => {
    const { adminUser, term, jss1, aisha, bilal } = await setupWorld();
    await computeResultsForClass({ classId: jss1.id, termId: term.id });
    await prisma.result.updateMany({ where: { termId: term.id }, data: { position: null, outOf: null } });

    for (const student of [aisha, bilal]) {
      await finalizeResult((await card(student.id, term.id, "MADRASSAH")).id, adminUser.id);
    }

    expect((await card(bilal.id, term.id, "MADRASSAH")).position).toBe(1);
    expect((await card(aisha.id, term.id, "MADRASSAH")).position).toBe(2);
    // The Western card isn't fully finalized yet, so it stays unranked.
    expect((await card(aisha.id, term.id, "ACADEMIC")).position).toBeNull();
  });

  it("prints the class's school days on the Islamiyyah card too", async () => {
    const { adminUser, session, term, jss1, aisha } = await setupWorld();
    await prisma.attendanceSession.create({
      data: {
        classId: jss1.id,
        academicSessionId: session.id,
        termId: term.id,
        date: new Date("2026-09-10"),
        status: "CLOSED",
        openedByUserId: adminUser.id,
        records: {
          create: { studentId: aisha.id, status: "PRESENT", method: "MANUAL", recordedByUserId: adminUser.id },
        },
      },
    });
    await computeResultsForClass({ classId: jss1.id, termId: term.id });

    const finalized = await finalizeResult((await card(aisha.id, term.id, "MADRASSAH")).id, adminUser.id);

    expect(finalized.daysSchoolOpened).toBe(1);
    expect(finalized.daysPresent).toBe(1);
  });

  it("lists one card at a time for the class, the Western card by default", async () => {
    const { adminToken, term, jss1 } = await setupWorld();
    await computeResultsForClass({ classId: jss1.id, termId: term.id });
    const url = `/api/classes/${jss1.id}/results/${term.id}`;

    const western = await request(server).get(url).set("Authorization", `Bearer ${adminToken}`);
    const islamiyyah = await request(server)
      .get(`${url}?programme=MADRASSAH`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(western.status).toBe(200);
    expect((western.body as { programme: string }[]).map((r) => r.programme)).toEqual(["ACADEMIC", "ACADEMIC"]);
    expect((islamiyyah.body as { programme: string }[]).map((r) => r.programme)).toEqual([
      "MADRASSAH",
      "MADRASSAH",
    ]);
  });

  it("lets the Islamiyyah teacher, not the form teacher, run the Islamiyyah card", async () => {
    const { term, jss1, formTeacher, ustadh, aisha } = await setupWorld();
    await computeResultsForClass({ classId: jss1.id, termId: term.id });
    const western = await card(aisha.id, term.id, "ACADEMIC");
    const islamiyyah = await card(aisha.id, term.id, "MADRASSAH");
    const listUrl = `/api/classes/${jss1.id}/results/${term.id}`;
    const comment = (resultId: string, token: string) =>
      request(server)
        .patch(`/api/results/${resultId}/class-teacher-comment`)
        .set("Authorization", `Bearer ${token}`)
        .send({ comment: "Masha Allah" });

    // Reading: the form teacher sees both cards; the Islamiyyah teacher only theirs.
    expect((await request(server).get(`${listUrl}?programme=MADRASSAH`).set("Authorization", `Bearer ${formTeacher.token}`)).status).toBe(200);
    expect((await request(server).get(`${listUrl}?programme=MADRASSAH`).set("Authorization", `Bearer ${ustadh.token}`)).status).toBe(200);
    expect((await request(server).get(listUrl).set("Authorization", `Bearer ${ustadh.token}`)).status).toBe(403);

    // Writing: each card's own teacher.
    expect((await comment(islamiyyah.id, ustadh.token)).status).toBe(200);
    expect((await comment(islamiyyah.id, formTeacher.token)).status).toBe(403);
    expect((await comment(western.id, formTeacher.token)).status).toBe(200);
    expect((await comment(western.id, ustadh.token)).status).toBe(403);

    const submit = await request(server)
      .post(`/api/results/${islamiyyah.id}/submit`)
      .set("Authorization", `Bearer ${ustadh.token}`);
    expect(submit.status).toBe(200);
    expect((await card(aisha.id, term.id, "ACADEMIC")).status).toBe("DRAFT");
  });

  it("rates the Islamiyyah card separately, by the Islamiyyah teacher", async () => {
    const { session, term, jss1, formTeacher, ustadh, aisha } = await setupWorld();
    const trait = await prisma.trait.create({
      data: { academicSessionId: session.id, category: "AFFECTIVE", name: "Punctuality", order: 1 },
    });
    await computeResultsForClass({ classId: jss1.id, termId: term.id });
    const rate = (token: string, value: number, programme?: string) =>
      request(server)
        .put(`/api/classes/${jss1.id}/results/${term.id}/ratings${programme ? `?programme=${programme}` : ""}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ entries: [{ studentId: aisha.id, traitId: trait.id, value }] });

    expect((await rate(ustadh.token, 4, "MADRASSAH")).status).toBe(200);
    expect((await rate(formTeacher.token, 2, "MADRASSAH")).status).toBe(403);
    expect((await rate(ustadh.token, 2)).status).toBe(403);
    expect((await rate(formTeacher.token, 5)).status).toBe(200);

    const ratings = await prisma.rating.findMany({ where: { studentId: aisha.id }, orderBy: { programme: "asc" } });
    expect(ratings.map((r) => [r.programme, r.value])).toEqual([
      ["ACADEMIC", 5],
      ["MADRASSAH", 4],
    ]);
  });

  it("rolls up session results per card", async () => {
    const { adminUser, adminToken, session, term, jss1, aisha } = await setupWorld();
    await computeResultsForClass({ classId: jss1.id, termId: term.id });
    for (const result of await prisma.result.findMany({ where: { studentId: aisha.id } })) {
      await finalizeResult(result.id, adminUser.id);
    }

    const res = await request(server)
      .post("/api/session-results/compute")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ classId: jss1.id, academicSessionId: session.id });
    expect(res.status).toBe(200);

    const url = `/api/session-results/${aisha.id}/${session.id}`;
    const western = await request(server).get(url).set("Authorization", `Bearer ${adminToken}`);
    const islamiyyah = await request(server)
      .get(`${url}?programme=MADRASSAH`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(western.body).toMatchObject({ programme: "ACADEMIC", averageScore: "85" });
    expect(islamiyyah.body).toMatchObject({ programme: "MADRASSAH", averageScore: "50" });
  });

  it("summarises each card of a class as its own row", async () => {
    const { adminToken, term, jss1 } = await setupWorld();
    await computeResultsForClass({ classId: jss1.id, termId: term.id });

    const res = await request(server)
      .get(`/api/results/term-summary?termId=${term.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect((res.body as { classes: unknown[] }).classes).toEqual([
      expect.objectContaining({ classId: jss1.id, programme: "ACADEMIC", draft: 2 }),
      expect.objectContaining({ classId: jss1.id, programme: "MADRASSAH", draft: 2 }),
    ]);
  });
});
