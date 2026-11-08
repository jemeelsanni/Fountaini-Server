import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBareStudent, createClass, enrollStudent } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

/// Fee structures narrowed by programme, audience (new vs returning) and
/// gender — in generate-obligations and in auto-billing on enroll/transfer.

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

async function setup() {
  const { token } = await createAdmin("admin@test.local");
  const lastSession = await prisma.academicSession.create({
    data: { name: "2025/2026", startDate: new Date("2025-09-01"), endDate: new Date("2026-07-31") },
  });
  const session = await prisma.academicSession.create({
    data: { name: "2026/2027", startDate: new Date("2026-09-01"), endDate: new Date("2027-07-31"), isCurrent: true },
  });
  const basic4 = await createClass("Basic 4");
  const basic5 = await createClass("Basic 5", "A");
  const basic5b = await createClass("Basic 5", "B");
  const madrasa = await prisma.class.create({
    data: { gradeName: "Weekday Madrasa", arm: "Level 1", order: 100, programme: "MADRASSAH" },
  });

  const createStructure = (body: Record<string, unknown>) =>
    request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Fee", category: "OTHER", academicSessionId: session.id, amountKobo: 1_000_000, ...body });
  const generate = (structureId: string) =>
    request(server)
      .post(`/api/fee-structures/${structureId}/generate-obligations`)
      .set("Authorization", `Bearer ${token}`);
  const billedStudentIds = async (feeStructureId: string) =>
    (await prisma.feeObligation.findMany({ where: { feeStructureId }, select: { studentId: true } }))
      .map((o) => o.studentId)
      .sort();

  return { token, lastSession, session, basic4, basic5, basic5b, madrasa, createStructure, generate, billedStudentIds };
}

async function student(admissionNumber: string, gender: "MALE" | "FEMALE" | null = null) {
  const created = await createBareStudent(admissionNumber);
  return gender ? prisma.student.update({ where: { id: created.id }, data: { gender } }) : created;
}

describe("generate-obligations with fee targeting", () => {
  it("bills NEW_STUDENTS and RETURNING_STUDENTS by last-session enrollments of any status", async () => {
    const { lastSession, session, basic4, basic5, createStructure, generate, billedStudentIds } = await setup();
    const returning = await student("ADM-RET");
    const withdrawnLastYear = await student("ADM-WDN");
    const fresh = await student("ADM-NEW");
    await enrollStudent(returning.id, basic4.id, lastSession.id);
    const old = await enrollStudent(withdrawnLastYear.id, basic4.id, lastSession.id);
    await prisma.enrollment.update({ where: { id: old.id }, data: { status: "WITHDRAWN" } });
    for (const s of [returning, withdrawnLastYear, fresh]) {
      await enrollStudent(s.id, basic5.id, session.id);
    }

    const admissionForm = await createStructure({ name: "Admission form", audience: "NEW_STUDENTS" });
    const returningLevy = await createStructure({ name: "Returning levy", audience: "RETURNING_STUDENTS" });
    expect(admissionForm.status).toBe(201);
    expect((await generate(admissionForm.body.id as string)).status).toBe(201);
    expect((await generate(returningLevy.body.id as string)).status).toBe(201);

    expect(await billedStudentIds(admissionForm.body.id as string)).toEqual([fresh.id]);
    expect(await billedStudentIds(returningLevy.body.id as string)).toEqual([returning.id, withdrawnLastYear.id].sort());
  });

  it("bills a gendered fee only to that gender, skipping students with no gender recorded", async () => {
    const { session, basic5, createStructure, generate, billedStudentIds } = await setup();
    const boy = await student("ADM-B", "MALE");
    const girl = await student("ADM-G", "FEMALE");
    const unknown = await student("ADM-U");
    for (const s of [boy, girl, unknown]) {
      await enrollStudent(s.id, basic5.id, session.id);
    }

    const boysUniform = await createStructure({ name: "Uniform (boys)", category: "UNIFORM", gender: "MALE", amountKobo: 7_500_000 });
    const girlsUniform = await createStructure({ name: "Uniform (girls)", category: "UNIFORM", gender: "FEMALE", amountKobo: 8_500_000 });
    await generate(boysUniform.body.id as string);
    await generate(girlsUniform.body.id as string);

    expect(await billedStudentIds(boysUniform.body.id as string)).toEqual([boy.id]);
    expect(await billedStudentIds(girlsUniform.body.id as string)).toEqual([girl.id]);
  });

  it("keeps Madrasa-only students out of an academic school-wide fee, and vice versa", async () => {
    const { session, basic5, madrasa, createStructure, generate, billedStudentIds } = await setup();
    const both = await student("ADM-BOTH");
    const madrasaOnly = await student("ADM-MAD");
    await enrollStudent(both.id, basic5.id, session.id);
    await enrollStudent(both.id, madrasa.id, session.id);
    await enrollStudent(madrasaOnly.id, madrasa.id, session.id);

    const tuition = await createStructure({ name: "Tuition" });
    const madrasaTuition = await createStructure({ name: "Madrasa tuition", programme: "MADRASSAH" });
    await generate(tuition.body.id as string);
    await generate(madrasaTuition.body.id as string);

    expect(await billedStudentIds(tuition.body.id as string)).toEqual([both.id]);
    expect(await billedStudentIds(madrasaTuition.body.id as string)).toEqual([both.id, madrasaOnly.id].sort());
  });

  it("400s with the widened message when nobody matches", async () => {
    const { session, basic5, createStructure, generate } = await setup();
    const unknown = await student("ADM-U");
    await enrollStudent(unknown.id, basic5.id, session.id);
    const structure = await createStructure({ gender: "FEMALE" });

    const res = await generate(structure.body.id as string);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "No actively enrolled students match this fee structure's class, programme, audience and gender",
    );
  });
});

describe("auto-billing on enroll and transfer", () => {
  it("bills a new enrollment for every matching active structure, and re-generating adds no duplicates", async () => {
    const { token, session, basic5, createStructure, generate } = await setup();
    const tuition = await createStructure({ name: "Tuition", gradeName: "Basic 5" });
    const form = await createStructure({ name: "Admission form", audience: "NEW_STUDENTS" });
    const girls = await createStructure({ name: "Uniform (girls)", gender: "FEMALE" });
    const madrasaFee = await createStructure({ name: "Madrasa", programme: "MADRASSAH" });
    const inactive = await createStructure({ name: "Retired fee" });
    await prisma.feeStructure.update({ where: { id: inactive.body.id as string }, data: { isActive: false } });
    const boy = await student("ADM-B", "MALE");

    const res = await request(server)
      .post(`/api/students/${boy.id}/enrollments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: basic5.id, academicSessionId: session.id });

    expect(res.status).toBe(201);
    const billed = await prisma.feeObligation.findMany({ where: { studentId: boy.id }, select: { feeStructureId: true } });
    // Not girls (gender), not madrasaFee (programme), not inactive.
    expect(billed.map((o) => o.feeStructureId).sort()).toEqual([tuition.body.id, form.body.id].sort());
    expect([girls, madrasaFee].every((r) => r.status === 201)).toBe(true);

    await generate(tuition.body.id as string);
    await generate(form.body.id as string);
    expect(await prisma.feeObligation.count({ where: { studentId: boy.id } })).toBe(2);
  });

  it("on transfer, replaces a same-category class fee instead of doubling it, and still adds new categories", async () => {
    const { token, session, basic5, basic5b, createStructure } = await setup();
    const aTuition = await createStructure({ name: "Basic 5A tuition", category: "TUITION", classId: basic5.id });
    const bTuition = await createStructure({ name: "Basic 5B tuition", category: "TUITION", classId: basic5b.id });
    const bTrip = await createStructure({ name: "Basic 5B trip", category: "OTHER", classId: basic5b.id });
    const s = await student("ADM-X");
    await request(server)
      .post(`/api/students/${s.id}/enrollments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: basic5.id, academicSessionId: session.id });

    const res = await request(server)
      .post(`/api/students/${s.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: basic5b.id });

    expect(res.status).toBe(200);
    const billed = await prisma.feeObligation.findMany({ where: { studentId: s.id }, select: { feeStructureId: true } });
    // 5A tuition kept as it was; 5B tuition not added on top; 5B trip added.
    expect(billed.map((o) => o.feeStructureId).sort()).toEqual([aTuition.body.id, bTrip.body.id].sort());
    expect(bTuition.status).toBe(201);
  });

  it("doesn't bill a mid-session enrollee for a term that had already ended", async () => {
    const { token, session, basic5, createStructure } = await setup();
    const ended = await prisma.term.create({
      data: { academicSessionId: session.id, name: "First Term", order: 1, startDate: new Date("2026-01-05"), endDate: new Date("2026-02-01") },
    });
    const upcoming = await prisma.term.create({
      data: { academicSessionId: session.id, name: "Third Term", order: 3, startDate: new Date("2099-04-20"), endDate: new Date("2099-07-24") },
    });
    await createStructure({ name: "Tuition — first term", termId: ended.id });
    const upcomingTuition = await createStructure({ name: "Tuition — third term", termId: upcoming.id });
    const sessionWide = await createStructure({ name: "Development levy" });
    const s = await student("ADM-LATE");

    await request(server)
      .post(`/api/students/${s.id}/enrollments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ classId: basic5.id, academicSessionId: session.id });

    const billed = await prisma.feeObligation.findMany({ where: { studentId: s.id }, select: { feeStructureId: true } });
    expect(billed.map((o) => o.feeStructureId).sort()).toEqual([upcomingTuition.body.id, sessionWide.body.id].sort());
  });
});

describe("fee structure targeting validation", () => {
  it("rejects a class or grade outside the structure's programme, on create and on update", async () => {
    const { token, basic5, madrasa, createStructure } = await setup();

    const madrasaFeeOnBasic = await createStructure({ programme: "MADRASSAH", classId: basic5.id });
    const madrasaFeeOnBasicGrade = await createStructure({ programme: "MADRASSAH", gradeName: "Basic 5" });
    expect(madrasaFeeOnBasic.status).toBe(400);
    expect(madrasaFeeOnBasicGrade.status).toBe(400);

    const structure = await createStructure({ programme: "MADRASSAH", classId: madrasa.id });
    expect(structure.status).toBe(201);
    const switchProgramme = await request(server)
      .patch(`/api/fee-structures/${structure.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ programme: "ACADEMIC" });
    expect(switchProgramme.status).toBe(400);
  });

  it("refuses to change who a structure bills once it has billed anyone", async () => {
    const { token, session, basic5, createStructure, generate } = await setup();
    const s = await student("ADM-U", "FEMALE");
    await enrollStudent(s.id, basic5.id, session.id);
    const uniform = await createStructure({ name: "Uniform", category: "UNIFORM" });
    await generate(uniform.body.id as string);
    const patch = (body: object) =>
      request(server).patch(`/api/fee-structures/${uniform.body.id}`).set("Authorization", `Bearer ${token}`).send(body);

    const toBoys = await patch({ gender: "MALE" });
    const rename = await patch({ name: "School uniform", gender: null });

    expect(toBoys.status).toBe(409);
    expect(toBoys.body.error.message).toMatch(/already billed 1 student, so its gender can't be changed/);
    // gender null -> null isn't a change, so an unrelated edit still goes through.
    expect(rename.status).toBe(200);
  });

  it("updates audience and gender, and null clears gender", async () => {
    const { token, createStructure } = await setup();
    const structure = await createStructure({ gender: "MALE" });
    const patch = (body: object) =>
      request(server).patch(`/api/fee-structures/${structure.body.id}`).set("Authorization", `Bearer ${token}`).send(body);

    const updated = await patch({ audience: "NEW_STUDENTS", gender: null });
    const invalid = await patch({ audience: "EVERYONE" });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ audience: "NEW_STUDENTS", gender: null, programme: "ACADEMIC" });
    expect(invalid.status).toBe(400);
  });
});
