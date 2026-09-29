import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import { drainFireAndForget } from "../../lib/fireAndForget.js";
import {
  createAdmin,
  createBareStudent,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
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

/// Shared by several describe blocks below (payment recording/confirmation,
/// the bursar's queue) — module scope, not local to one describe, so it
/// isn't duplicated per block.
async function setupObligation() {
  const { token: adminToken } = await createAdmin("admin@test.local");
  const { token: bursarToken } = await createBursar("bursar@test.local");

  const session = await createCurrentAcademicSession("2026/2027");
  const klass = await createClass("JSS1", "A");
  const student = await createBareStudent("ADM-001");
  await enrollStudent(student.id, klass.id, session.id);

  const structureRes = await request(server)
    .post("/api/fee-structures")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 10_000_000 });
  await request(server)
    .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
    .set("Authorization", `Bearer ${adminToken}`);
  const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });

  return { adminToken, bursarToken, student, obligation };
}

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

    const structureRes = await request(server)
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

    const generateRes = await request(server)
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
    await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const count = await prisma.feeObligation.count({ where: { feeStructureId: structureRes.body.id } });
    expect(count).toBe(2);
  });

  it("a gradeName structure bills every arm of that level, including one created after the structure", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const armA = await createClass("JSS1", "A");
    const armB = await createClass("JSS1", "B");
    const studentA = await createBareStudent("ADM-GRADE-001");
    const studentB = await createBareStudent("ADM-GRADE-002");
    await enrollStudent(studentA.id, armA.id, session.id);
    await enrollStudent(studentB.id, armB.id, session.id);

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "JSS1 Tuition",
        category: "TUITION",
        gradeName: "JSS1",
        academicSessionId: session.id,
        amountKobo: 5_000_000,
      });
    expect(structureRes.status).toBe(201);

    // A third arm, created AFTER the structure — the targeting must be
    // resolved fresh at generate time, not fixed at creation time.
    const armC = await createClass("JSS1", "C");
    const studentC = await createBareStudent("ADM-GRADE-003");
    await enrollStudent(studentC.id, armC.id, session.id);

    const generateRes = await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(generateRes.status).toBe(201);

    const studentIds = (generateRes.body as Array<{ studentId: string }>).map((o) => o.studentId);
    expect(studentIds).toContain(studentA.id);
    expect(studentIds).toContain(studentB.id);
    expect(studentIds).toContain(studentC.id);
    expect(studentIds).toHaveLength(3);
  });

  it("rejects a fee structure that sets both classId and gradeName", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");

    const res = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Conflicting Target",
        category: "TUITION",
        classId: klass.id,
        gradeName: "JSS1",
        academicSessionId: session.id,
        amountKobo: 5_000_000,
      });

    expect(res.status).toBe(400);
  });

  it("rejects an update that would leave both classId and gradeName set, whether set together or one already existed on the row", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "JSS1 Tuition",
        category: "TUITION",
        classId: klass.id,
        academicSessionId: session.id,
        amountKobo: 5_000_000,
      });
    expect(structureRes.status).toBe(201);

    // Existing row already has classId — this update sets only gradeName,
    // but the schema-level check alone can't see that; the merge check in
    // updateFeeStructure is what catches this half.
    const res = await request(server)
      .patch(`/api/fee-structures/${structureRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ gradeName: "JSS1" });

    expect(res.status).toBe(400);
  });
});

describe("payment recording, confirmation, and balance math", () => {
  it("marks PARTIALLY_PAID after one installment and PAID once fully covered, with exact kobo math", async () => {
    const { adminToken, bursarToken, student, obligation } = await setupObligation();

    // Recorded and confirmed by BURSAR — proving that role, not just ADMIN, works here.
    const payment1 = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ amountKobo: 4_000_000, paymentDate: "2026-09-10", bankReference: "TXN-001" });
    expect(payment1.status).toBe(201);
    expect(payment1.body.status).toBe("PENDING");

    const confirm1 = await request(server)
      .post(`/api/payments/${payment1.body.id}/confirm`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(confirm1.status).toBe(200);
    expect(confirm1.body.status).toBe("CONFIRMED");

    const receipt1 = await request(server)
      .get(`/api/payments/${payment1.body.id}/receipt`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(receipt1.status).toBe(200);
    expect(typeof receipt1.body.receiptNumber).toBe("string");

    let balances = await request(server)
      .get(`/api/students/${student.id}/fee-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(balances.body[0].status).toBe("PARTIALLY_PAID");
    expect(balances.body[0].totalPaidKobo).toBe(4_000_000);
    expect(balances.body[0].outstandingKobo).toBe(6_000_000);

    const payment2 = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 6_000_000, paymentDate: "2026-10-01" });
    await request(server)
      .post(`/api/payments/${payment2.body.id}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`);

    balances = await request(server)
      .get(`/api/students/${student.id}/fee-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(balances.body[0].status).toBe("PAID");
    expect(balances.body[0].totalPaidKobo).toBe(10_000_000);
    expect(balances.body[0].outstandingKobo).toBe(0);
  });

  it("a rejected payment does not count toward the balance", async () => {
    const { adminToken, obligation } = await setupObligation();

    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 10_000_000, paymentDate: "2026-09-10" });

    const rejectRes = await request(server)
      .post(`/api/payments/${payment.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("REJECTED");

    const refreshedObligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(refreshedObligation.status).toBe("PENDING");

    const receiptAttempt = await request(server)
      .get(`/api/payments/${payment.body.id}/receipt`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(receiptAttempt.status).toBe(404);
  });

  it("rejects confirming or rejecting a payment that isn't PENDING anymore", async () => {
    const { adminToken, obligation } = await setupObligation();
    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 1_000_000, paymentDate: "2026-09-10" });

    await request(server).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);
    const secondConfirm = await request(server)
      .post(`/api/payments/${payment.body.id}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(secondConfirm.status).toBe(409);

    const rejectAfterConfirm = await request(server)
      .post(`/api/payments/${payment.body.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(rejectAfterConfirm.status).toBe(409);
  });

  it("resolves two concurrent confirms of the same payment as one 200 and one 409, with exactly one receipt", async () => {
    const { adminToken, bursarToken, obligation } = await setupObligation();
    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 1_000_000, paymentDate: "2026-09-10" });

    const [resA, resB] = await Promise.all([
      request(server)
        .post(`/api/payments/${payment.body.id}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`),
      request(server)
        .post(`/api/payments/${payment.body.id}/confirm`)
        .set("Authorization", `Bearer ${bursarToken}`),
    ]);
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const receipts = await prisma.receipt.findMany({ where: { paymentId: payment.body.id } });
    expect(receipts).toHaveLength(1);
  });
});

// Who can read /students/:id/fee-obligations (admin/bursar/linked parent/own
// student allowed; assigned teacher, unlinked parent, and other students
// denied — deliberately narrower than academic-data scoping) is covered by
// the auth matrix (src/authorization/authMatrix.data.ts).

describe("BURSAR has a working portal end to end", () => {
  it("can create a structure, generate obligations, record/confirm a payment, read the obligation and receipt, and edit/delete a structure", async () => {
    const { token: bursarToken } = await createBursar("bursar-portal@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    expect(structureRes.status).toBe(201);

    const generateRes = await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(generateRes.status).toBe(201);
    const obligationId = generateRes.body[0].id as string;

    const getObligation = await request(server)
      .get(`/api/fee-obligations/${obligationId}`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(getObligation.status).toBe(200);
    expect(getObligation.body.outstandingKobo).toBe(5_000_000);

    const paymentRes = await request(server)
      .post(`/api/fee-obligations/${obligationId}/payments`)
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    expect(paymentRes.status).toBe(201);

    const confirmRes = await request(server)
      .post(`/api/payments/${paymentRes.body.id}/confirm`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(confirmRes.status).toBe(200);

    const receiptRes = await request(server)
      .get(`/api/payments/${paymentRes.body.id}/receipt`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(receiptRes.status).toBe(200);

    const patchStructureRes = await request(server)
      .patch(`/api/fee-structures/${structureRes.body.id}`)
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ name: "Tuition (revised)" });
    expect(patchStructureRes.status).toBe(200);
    expect(patchStructureRes.body.name).toBe("Tuition (revised)");

    // This structure has a generated obligation — delete must refuse.
    const deleteWithObligations = await request(server)
      .delete(`/api/fee-structures/${structureRes.body.id}`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(deleteWithObligations.status).toBe(409);

    // A second, untouched structure has none — delete succeeds.
    const secondStructureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${bursarToken}`)
      .send({ name: "Uniform", category: "UNIFORM", academicSessionId: session.id, amountKobo: 1_000_000 });
    const deleteWithoutObligations = await request(server)
      .delete(`/api/fee-structures/${secondStructureRes.body.id}`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(deleteWithoutObligations.status).toBe(204);
  });

  // Confirms BURSAR's access is exactly as scoped — finance only. The auth
  // matrix already proves this exhaustively for every route; this is a
  // direct, readable smoke check on a couple of representative
  // non-finance routes, matching what was explicitly asked for here.
  it("is denied on results and scores routes", async () => {
    const { token: bursarToken } = await createBursar("bursar-denied@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const student = await createBareStudent("ADM-002");

    const resultsRes = await request(server)
      .get(`/api/results/${student.id}/${term.id}`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(resultsRes.status).toBe(403);

    const scoresRes = await request(server)
      .get(`/api/students/${student.id}/scores`)
      .set("Authorization", `Bearer ${bursarToken}`);
    expect(scoresRes.status).toBe(403);
  });
});

describe("PATCH /api/fee-structures/:id", () => {
  it("does not retroactively alter an obligation already generated at the old amount", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });
    expect(obligation.amountDueKobo).toBe(5_000_000);

    const patchRes = await request(server)
      .patch(`/api/fee-structures/${structureRes.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 8_000_000 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.amountKobo).toBe(8_000_000);

    const unchangedObligation = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(unchangedObligation.amountDueKobo).toBe(5_000_000);
  });
});

describe("GET /api/fee-obligations/:id", () => {
  it("is readable by the linked parent and the student themself, not an unrelated parent", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const { student, token: studentToken } = await createStudentWithLogin("student@test.local", "ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const { parent, token: parentToken } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" },
    });
    const { token: unrelatedParentToken } = await createParent("unrelated-parent@test.local");

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    const generateRes = await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligationId = generateRes.body[0].id as string;

    const asParent = await request(server)
      .get(`/api/fee-obligations/${obligationId}`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(asParent.status).toBe(200);

    const asStudent = await request(server)
      .get(`/api/fee-obligations/${obligationId}`)
      .set("Authorization", `Bearer ${studentToken}`);
    expect(asStudent.status).toBe(200);

    const asUnrelatedParent = await request(server)
      .get(`/api/fee-obligations/${obligationId}`)
      .set("Authorization", `Bearer ${unrelatedParentToken}`);
    expect(asUnrelatedParent.status).toBe(403);
  });
});

describe("PARENT logs a payment against their own child's obligation", () => {
  async function setupLinkedObligation() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);
    const { parent, token: parentToken } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" },
    });

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });

    return { adminToken, parentToken, parent, student, obligation };
  }

  it("creates a payment claim — 201, status PENDING", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10", bankReference: "PARENT-TXN-001" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.recordedByUserId).toBeTruthy();

    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.status).toBe("PENDING");
  });

  it("the audit row records that a parent logged it, not just that a payment appeared", async () => {
    const { parentToken, parent, obligation } = await setupLinkedObligation();

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    expect(res.status).toBe(201);

    // auditMutation() writes through the fire-and-forget wrapper — the
    // AuditLog row can land after this response already returned.
    await drainFireAndForget();

    // entityId here is the fee obligation's id, not the new payment's:
    // auditMutation() resolves entityId from req.params.id first, falling
    // back to the response body's id only when there's no :id param at all
    // — and for this nested-creation route, :id in the URL names the
    // PARENT resource (the obligation), the same shape already noted for
    // POST /api/parents/:id/children in that middleware's own comment.
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: "Payment", entityId: obligation.id, action: "PAYMENT_RECORDED" },
    });
    expect(entry.actorUserId).toBe(parent.userId);
    expect(entry.actorRoles).toEqual(["PARENT"]);
  });

  it("rejects a claim against another family's obligation — 403", async () => {
    const { obligation } = await setupLinkedObligation();
    const { token: unrelatedParentToken } = await createParent("unrelated-parent@test.local");

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${unrelatedParentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });

    expect(res.status).toBe(403);
    const count = await prisma.payment.count({ where: { feeObligationId: obligation.id } });
    expect(count).toBe(0);
  });

  it("ignores a status set in the request body — the row is PENDING regardless of what was sent", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10", status: "CONFIRMED" });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
  });

  it("blocks a parent from confirming or rejecting any payment, including their own claim", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();

    const claim = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    expect(claim.status).toBe(201);

    const confirmRes = await request(server)
      .post(`/api/payments/${claim.body.id}/confirm`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(confirmRes.status).toBe(403);

    const rejectRes = await request(server)
      .post(`/api/payments/${claim.body.id}/reject`)
      .set("Authorization", `Bearer ${parentToken}`);
    expect(rejectRes.status).toBe(403);

    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: claim.body.id as string } });
    expect(stored.status).toBe("PENDING");
  });

  it("a bursar confirming a parent-logged payment moves the balance — collected rises, pending falls", async () => {
    const { adminToken, parentToken, obligation } = await setupLinkedObligation();

    const claim = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    expect(claim.status).toBe(201);

    const beforeConfirm = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(beforeConfirm.status).toBe("PENDING");

    const confirmRes = await request(server)
      .post(`/api/payments/${claim.body.id}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(confirmRes.status).toBe(200);

    const afterConfirm = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(afterConfirm.status).toBe("PAID");
  });

  it("blocks a second pending claim from a parent on the same obligation, but not from staff", async () => {
    const { adminToken, parentToken, obligation } = await setupLinkedObligation();

    const first = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-10" });
    expect(first.status).toBe(201);

    const second = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-11" });
    expect(second.status).toBe(409);

    // Staff are exempt — a legitimate manual/installment entry must not be
    // blocked by a parent's own outstanding claim on the same obligation.
    const staffEntry = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 1_000_000, paymentDate: "2026-09-12" });
    expect(staffEntry.status).toBe(201);
  });
});

describe("GET /api/payments — the bursar's queue", () => {
  it("defaults to PENDING and excludes a confirmed payment", async () => {
    const { adminToken, obligation } = await setupObligation();

    const pending = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-10", bankReference: "PENDING-1" });
    const toConfirm = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 3_000_000, paymentDate: "2026-09-11", bankReference: "CONFIRMED-1" });
    await request(server).post(`/api/payments/${toConfirm.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    const res = await request(server).get("/api/payments").set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const ids = (res.body.data as Array<{ id: string; status: string }>).map((p) => p.id);
    expect(ids).toContain(pending.body.id);
    expect(ids).not.toContain(toConfirm.body.id);
    for (const row of res.body.data as Array<{ status: string }>) {
      expect(row.status).toBe("PENDING");
    }
  });

  it("each row carries enough to triage: student, admission number, class, amount, bank reference, who logged it, and the obligation's balance", async () => {
    const { adminToken, student, obligation } = await setupObligation();

    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 4_000_000, paymentDate: "2026-09-10", bankReference: "TRIAGE-1" });
    expect(payment.status).toBe(201);

    const res = await request(server).get("/api/payments").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = (res.body.data as Array<Record<string, unknown>>).find((r) => r.id === payment.body.id)!;

    expect(row.student).toMatchObject({ id: student.id, name: "Bare Student", admissionNumber: "ADM-001" });
    expect(row.class).toMatchObject({ name: "JSS1 A" });
    expect(row.amountKobo).toBe(4_000_000);
    expect(row.bankReference).toBe("TRIAGE-1");
    expect(row.recordedByName).toBeTruthy();
    // Obligation is 10,000,000 due, nothing confirmed yet — the PENDING
    // claim itself must not move this: only CONFIRMED payments count.
    expect(row.obligationOutstandingKobo).toBe(10_000_000);
  });

  it("excludes a payment when filtered by an unrelated classId", async () => {
    const { adminToken, obligation } = await setupObligation();
    const otherClass = await createClass("JSS2", "A");

    await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-10" });

    const res = await request(server)
      .get(`/api/payments?classId=${otherClass.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/payments").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/fees/summary", () => {
  async function seedSummaryScenario() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const term = await createTermForSession(session.id, "First Term", 1);
    const klass = await createClass("JSS1", "A");

    async function obligationFor(admissionNumber: string, amountDueKobo: number) {
      const student = await createBareStudent(admissionNumber);
      await enrollStudent(student.id, klass.id, session.id);
      const structure = await prisma.feeStructure.create({
        data: { name: `Fee-${admissionNumber}`, category: "TUITION", classId: klass.id, academicSessionId: session.id, termId: term.id, amountKobo: amountDueKobo },
      });
      return prisma.feeObligation.create({
        data: { studentId: student.id, feeStructureId: structure.id, academicSessionId: session.id, termId: term.id, amountDueKobo, createdByUserId: "seed" },
      });
    }

    // A: fully paid — one CONFIRMED payment covering the whole amount.
    const oblA = await obligationFor("SUM-A", 5_000_000);
    const payA = await request(server)
      .post(`/api/fee-obligations/${oblA.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payA.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    // B: a claim awaiting confirmation — PENDING, must not move collected or outstanding.
    const oblB = await obligationFor("SUM-B", 5_000_000);
    await request(server)
      .post(`/api/fee-obligations/${oblB.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-10" });

    // C: a rejected claim — must not count toward collected, pending, or outstanding relief.
    const oblC = await obligationFor("SUM-C", 5_000_000);
    const payC = await request(server)
      .post(`/api/fee-obligations/${oblC.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payC.body.id}/reject`).set("Authorization", `Bearer ${adminToken}`);

    // D: waived — excluded from expectedKobo, reported only in waivedKobo.
    const oblD = await obligationFor("SUM-D", 3_000_000);
    await request(server)
      .patch(`/api/fee-obligations/${oblD.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "WAIVED" });

    // E: partially paid — one CONFIRMED payment covering part of the amount.
    const oblE = await obligationFor("SUM-E", 4_000_000);
    const payE = await request(server)
      .post(`/api/fee-obligations/${oblE.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 1_500_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payE.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    return { adminToken, session, term, klass };
  }

  it("computes every bucket independently, and outstanding ignores pending entirely", async () => {
    const { adminToken, session } = await seedSummaryScenario();

    const res = await request(server)
      .get(`/api/fees/summary?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const { total } = res.body;
    // expected = A+B+C+E (non-waived), D excluded entirely.
    expect(total.expectedKobo).toBe(5_000_000 + 5_000_000 + 5_000_000 + 4_000_000);
    // collected = A (confirmed, full) + E (confirmed, partial). B's pending
    // and C's rejected payment both contribute nothing here.
    expect(total.collectedKobo).toBe(5_000_000 + 1_500_000);
    // pending = only B's unconfirmed claim. C's REJECTED payment must not
    // land here just because it was once a claim.
    expect(total.pendingKobo).toBe(2_000_000);
    // outstanding = expected - collected, NOT minus pending — folding
    // pending in would silently give 10,500,000 instead of the real 12,500,000.
    expect(total.outstandingKobo).toBe(total.expectedKobo - total.collectedKobo);
    expect(total.outstandingKobo).toBe(12_500_000);
    expect(total.waivedKobo).toBe(3_000_000);
    expect(total.fullyPaidCount).toBe(1);
    expect(total.partiallyPaidCount).toBe(1);
    expect(total.unpaidCount).toBe(2);
  });

  it("includes a per-class breakdown when classId is omitted, and omits it when scoped to one class", async () => {
    const { adminToken, session, klass } = await seedSummaryScenario();

    const unscoped = await request(server)
      .get(`/api/fees/summary?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(unscoped.status).toBe(200);
    expect(Array.isArray(unscoped.body.byClass)).toBe(true);
    const classRow = unscoped.body.byClass.find((c: { classId: string }) => c.classId === klass.id);
    expect(classRow.expectedKobo).toBe(unscoped.body.total.expectedKobo);

    const scoped = await request(server)
      .get(`/api/fees/summary?academicSessionId=${session.id}&classId=${klass.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.byClass).toBeUndefined();
    expect(scoped.body.total.expectedKobo).toBe(unscoped.body.total.expectedKobo);
  });

  it("TEACHER is blocked", async () => {
    const { token } = await createTeacher("teacher@test.local");
    const res = await request(server).get("/api/fees/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  // Not a bug in the summary — a real property of how fee structures can be
  // defined, which the summary is exactly the right place for the school to
  // notice: a class-specific structure and a grade-wide structure of the
  // same category both generate their own FeeObligation for the same
  // student (FeeObligation's only uniqueness guard is per-structure —
  // @@unique([studentId, feeStructureId, termId]) — so two DIFFERENT
  // structures billing the same student is never caught). expectedKobo sums
  // amountDueKobo across every non-WAIVED obligation in scope, so it counts
  // both.
  it("expectedKobo is inflated when a class-specific and a grade-wide structure of the same category both bill one student", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("OVERLAP-1");
    await enrollStudent(student.id, klass.id, session.id);

    const classSpecific = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition — JSS1A", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 8_500_000 });
    const gradeWide = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition — JSS1 (grade-wide)", category: "TUITION", gradeName: "JSS1", academicSessionId: session.id, amountKobo: 8_500_000 });

    await request(server)
      .post(`/api/fee-structures/${classSpecific.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    await request(server)
      .post(`/api/fee-structures/${gradeWide.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);

    const obligations = await prisma.feeObligation.findMany({ where: { studentId: student.id } });
    expect(obligations).toHaveLength(2); // both structures billed the same student — nothing stopped it

    const res = await request(server)
      .get(`/api/fees/summary?academicSessionId=${session.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    // A school intending ONE ₦85,000 tuition fee for this student sees
    // ₦170,000 expected instead — double, from a genuine, undetected overlap.
    expect(res.body.total.expectedKobo).toBe(17_000_000);
  });
});

describe("GET /api/students/:id/statement", () => {
  async function setupStatement() {
    const { token: adminToken } = await createAdmin("admin@test.local");
    await request(server)
      .post("/api/school")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Fountaini International School" });
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("STMT-1");
    await enrollStudent(student.id, klass.id, session.id);
    const { parent, token: parentToken } = await createParent("stmt-parent@test.local");
    await prisma.studentParent.create({ data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" } });

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });
    const payment = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 2_000_000, paymentDate: "2026-09-10", bankReference: "STMT-REF" });

    return { adminToken, parentToken, student, obligation, payment: payment.body };
  }

  it("returns 200 for the linked parent, with school header, obligations, and every payment at every status", async () => {
    const { parentToken, student, obligation, payment } = await setupStatement();

    const res = await request(server)
      .get(`/api/students/${student.id}/statement`)
      .set("Authorization", `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.school.name).toBeTruthy();
    expect(res.body.student.id).toBe(student.id);
    const row = res.body.obligations.find((o: { id: string }) => o.id === obligation.id);
    expect(row.amountDueKobo).toBe(5_000_000);
    expect(row.payments).toHaveLength(1);
    expect(row.payments[0]).toMatchObject({ id: payment.id, status: "PENDING", bankReference: "STMT-REF" });
    // PENDING, so it must not have moved the balance yet.
    expect(row.balanceKobo).toBe(5_000_000);
  });

  it("returns 403 for an unrelated parent", async () => {
    const { student } = await setupStatement();
    const { token: unrelatedParentToken } = await createParent("stmt-unrelated@test.local");

    const res = await request(server)
      .get(`/api/students/${student.id}/statement`)
      .set("Authorization", `Bearer ${unrelatedParentToken}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /api/payments/:id", () => {
  it("shows the obligation's balance before and after this claim would apply", async () => {
    const { adminToken, obligation } = await setupObligation();

    const first = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 3_000_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${first.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    // A second, still-PENDING claim on the same (10,000,000) obligation —
    // 3,000,000 already confirmed, so before this one applies the balance
    // is 7,000,000; if confirmed, it would settle 5,000,000 of that.
    const second = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-11" });

    const res = await request(server).get(`/api/payments/${second.body.id}`).set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.balanceBeforeKobo).toBe(7_000_000);
    expect(res.body.balanceAfterKobo).toBe(2_000_000);
    expect(res.body.recordedByName).toBeTruthy();
  });
});
