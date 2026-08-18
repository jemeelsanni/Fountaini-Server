import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createBursar,
  createClass,
  createCurrentAcademicSession,
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

describe("fee structures and obligation generation", () => {
  it("generates one obligation per actively-enrolled student in scope, and skips them on re-run", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student1 = await createBareStudent("ADM-001");
    const student2 = await createBareStudent("ADM-002");
    const unenrolledStudent = await createBareStudent("ADM-003");
    await enrollStudent(student1.id, klass.id, session.id);
    await enrollStudent(student2.id, klass.id, session.id);

    const structureRes = await request(app)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Term 1 Tuition",
        category: "TUITION",
        classId: klass.id,
        academicSessionId: session.id,
        amountKobo: 5_000_000,
      });
    expect(structureRes.status).toBe(201);

    const generateRes = await request(app)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(generateRes.status).toBe(201);
    expect(generateRes.body).toHaveLength(2);
    expect(generateRes.body.every((o: { amountDueKobo: number }) => o.amountDueKobo === 5_000_000)).toBe(
      true,
    );

    const studentIds = generateRes.body.map((o: { studentId: string }) => o.studentId);
    expect(studentIds).toContain(student1.id);
    expect(studentIds).toContain(student2.id);
    expect(studentIds).not.toContain(unenrolledStudent.id);

    // Re-running does not create duplicates.
    await request(app)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const count = await prisma.feeObligation.count({ where: { feeStructureId: structureRes.body.id } });
    expect(count).toBe(2);
  });
});

describe("payment recording, confirmation, and balance math", () => {
  async function setupObligation() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { token: bursarToken } = await createBursar("bursar@test.local");

    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const structureRes = await request(app)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 10_000_000 });
    await request(app)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });

    return { adminToken, bursarToken, student, obligation };
  }

  it("marks PARTIALLY_PAID after one installment and PAID once fully covered, with exact kobo math", async () => {
    const { adminToken, bursarToken, student, obligation } = await setupObligation();

    // Recorded and confirmed by BURSAR — proving that role, not just ADMIN, works here.
    const payment1 = await request(app)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ amountKobo: 4_000_000, paymentDate: "2026-09-10", bankReference: "TXN-001" });
    expect(payment1.status).toBe(201);
    expect(payment1.body.status).toBe("PENDING");

    const confirm1 = await request(app)
      .post(`/api/payments/${payment1.body.id}/confirm`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(confirm1.status).toBe(200);
    expect(confirm1.body.status).toBe("CONFIRMED");

    const receipt1 = await request(app)
      .get(`/api/payments/${payment1.body.id}/receipt`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(receipt1.status).toBe(200);
    expect(typeof receipt1.body.receiptNumber).toBe("string");

    let balances = await request(app)
      .get(`/api/students/${student.id}/fee-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(balances.body[0].status).toBe("PARTIALLY_PAID");
    expect(balances.body[0].totalPaidKobo).toBe(4_000_000);
    expect(balances.body[0].outstandingKobo).toBe(6_000_000);

    const payment2 = await request(app)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 6_000_000, paymentDate: "2026-10-01" });
    await request(app)
      .post(`/api/payments/${payment2.body.id}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`);

    balances = await request(app)
      .get(`/api/students/${student.id}/fee-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(balances.body[0].status).toBe("PAID");
    expect(balances.body[0].totalPaidKobo).toBe(10_000_000);
    expect(balances.body[0].outstandingKobo).toBe(0);
  });

  it("a rejected payment does not count toward the balance", async () => {
    const { adminToken, obligation } = await setupObligation();

    const payment = await request(app)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 10_000_000, paymentDate: "2026-09-10" });

    const rejectRes = await request(app)
      .post(`/api/payments/${payment.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("REJECTED");

    const refreshedObligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(refreshedObligation.status).toBe("PENDING");

    const receiptAttempt = await request(app)
      .get(`/api/payments/${payment.body.id}/receipt`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(receiptAttempt.status).toBe(404);
  });

  it("rejects confirming or rejecting a payment that isn't PENDING anymore", async () => {
    const { adminToken, obligation } = await setupObligation();
    const payment = await request(app)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 1_000_000, paymentDate: "2026-09-10" });

    await request(app).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);
    const secondConfirm = await request(app)
      .post(`/api/payments/${payment.body.id}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(secondConfirm.status).toBe(409);

    const rejectAfterConfirm = await request(app)
      .post(`/api/payments/${payment.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(rejectAfterConfirm.status).toBe(409);
  });
});

// Who can read /students/:id/fee-obligations (admin/bursar/linked parent/own
// student allowed; assigned teacher, unlinked parent, and other students
// denied — deliberately narrower than academic-data scoping) is covered by
// the auth matrix (src/authorization/authMatrix.data.ts).
