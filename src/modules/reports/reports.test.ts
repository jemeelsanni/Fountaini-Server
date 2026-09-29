import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { createAdmin, createBareStudent, createClass, createCurrentAcademicSession, createParent, createTeacher, createTermForSession, enrollStudent } from "../../test/factories.js";
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

async function seedTwoStudents() {
  const { token: adminToken } = await createAdmin("admin@test.local");
  const session = await createCurrentAcademicSession("2026/2027");
  const term = await createTermForSession(session.id, "First Term", 1);
  const klass = await createClass("JSS1", "A");

  const unpaid = await createBareStudent("REP-UNPAID");
  await enrollStudent(unpaid.id, klass.id, session.id);
  const { parent } = await createParent("defaulter-parent@test.local");
  await prisma.studentParent.create({
    data: { parentId: parent.id, studentId: unpaid.id, relationship: "MOTHER", isPrimaryContact: true },
  });
  await prisma.parent.update({ where: { id: parent.id }, data: { phone: "+2348011112222" } });

  const paid = await createBareStudent("REP-PAID");
  await enrollStudent(paid.id, klass.id, session.id);

  const structure = await request(server)
    .post("/api/fee-structures")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, termId: term.id, amountKobo: 5_000_000 });
  await request(server)
    .post(`/api/fee-structures/${structure.body.id}/generate-obligations`)
    .set("Authorization", `Bearer ${adminToken}`);

  const paidObligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: paid.id } });
  const paidPayment = await request(server)
    .post(`/api/fee-obligations/${paidObligation.id}/payments`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10", bankReference: "PAID-REF" });
  await request(server).post(`/api/payments/${paidPayment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

  return { adminToken, session, term, klass, unpaid, paid };
}

describe("GET /api/reports/defaulters", () => {
  it("excludes a fully-paid student and includes an unpaid one, with the primary contact's name and phone", async () => {
    const { adminToken, session, unpaid, paid } = await seedTwoStudents();

    const res = await request(server)
      .get(`/api/reports/defaulters?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const studentIds = (res.body as Array<{ studentId: string }>).map((r) => r.studentId);
    expect(studentIds).toContain(unpaid.id);
    expect(studentIds).not.toContain(paid.id);

    const row = (res.body as Array<{ studentId: string; outstandingKobo: number; primaryContact: { name: string; phone: string } }>).find(
      (r) => r.studentId === unpaid.id,
    )!;
    expect(row.outstandingKobo).toBe(5_000_000);
    expect(row.primaryContact.phone).toBe("+2348011112222");
  });

  it("includes a partially-paid student", async () => {
    const { adminToken, session, klass } = await seedTwoStudents();
    const partial = await createBareStudent("REP-PARTIAL");
    await enrollStudent(partial.id, klass.id, session.id);

    const structure = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Levy", category: "OTHER", classId: klass.id, academicSessionId: session.id, amountKobo: 2_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structure.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: partial.id } });
    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 500_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    const res = await request(server)
      .get(`/api/reports/defaulters?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const row = (res.body as Array<{ studentId: string; outstandingKobo: number }>).find((r) => r.studentId === partial.id);
    expect(row).toBeTruthy();
    expect(row?.outstandingKobo).toBe(1_500_000);
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/reports/defaulters").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/reports/collections", () => {
  it("reports expected/collected/outstanding per class", async () => {
    const { adminToken, session, klass } = await seedTwoStudents();

    const res = await request(server)
      .get(`/api/reports/collections?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const row = (res.body as Array<{ classId: string }>).find((r) => r.classId === klass.id);
    expect(row).toMatchObject({ expectedKobo: 10_000_000, collectedKobo: 5_000_000, outstandingKobo: 5_000_000 });
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/reports/collections").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/reports/payments", () => {
  it("excludes a payment outside the given date range", async () => {
    const { adminToken, paid: student, session, klass } = await seedTwoStudents();
    void student;
    const structure = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Excursion", category: "OTHER", classId: klass.id, academicSessionId: session.id, amountKobo: 1_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structure.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligations = await prisma.feeObligation.findMany({ where: { feeStructureId: structure.body.id } });

    const inRange = await request(server)
      .post(`/api/fee-obligations/${obligations[0]!.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 100_000, paymentDate: "2026-06-15", bankReference: "IN-RANGE" });
    const outOfRange = await request(server)
      .post(`/api/fee-obligations/${obligations[1]!.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 200_000, paymentDate: "2026-01-01", bankReference: "OUT-OF-RANGE" });

    const res = await request(server)
      .get("/api/reports/payments?from=2026-06-01&to=2026-06-30")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(inRange.body.id);
    expect(ids).not.toContain(outOfRange.body.id);
  });

  it("returns CSV with the bank reference as the reconciliation join key when format=csv", async () => {
    const { adminToken, paid } = await seedTwoStudents();
    void paid;

    const res = await request(server)
      .get("/api/reports/payments?format=csv")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toMatch(/^paymentDate,studentName,admissionNumber,amountKobo,status,bankReference,recordedByUserId/);
    expect(res.text).toContain("PAID-REF");
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/reports/payments").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/reports/term-summary", () => {
  it("includes the dashboard buckets plus payment counts by status", async () => {
    const { adminToken, session } = await seedTwoStudents();

    const res = await request(server)
      .get(`/api/reports/term-summary?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.expectedKobo).toBe(10_000_000);
    expect(res.body.collectedKobo).toBe(5_000_000);
    expect(res.body.paymentCounts).toMatchObject({ pendingCount: 0, confirmedCount: 1, rejectedCount: 0 });
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/reports/term-summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
