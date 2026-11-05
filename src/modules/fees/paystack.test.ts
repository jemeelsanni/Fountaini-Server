import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createClass,
  createCurrentAcademicSession,
  createParent,
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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await resetDb();
});

const TUITION_KOBO = 5_000_000;

/// Stubs only calls to api.paystack.co — supertest talks to the local server
/// over node:http, not fetch, so nothing else in a test goes through here.
/// Returns the spy so a test can assert what was sent to Paystack.
function stubPaystack(responses: { initialize?: unknown; verify?: unknown; initializeStatus?: number }) {
  const realFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith("https://api.paystack.co/transaction/initialize")) {
      return Promise.resolve(
        new Response(JSON.stringify(responses.initialize), { status: responses.initializeStatus ?? 200 }),
      );
    }
    if (url.startsWith("https://api.paystack.co/transaction/verify/")) {
      return Promise.resolve(new Response(JSON.stringify(responses.verify), { status: 200 }));
    }
    return realFetch(input, init);
  });
}

function checkoutResponse() {
  return {
    status: true,
    message: "Authorization URL created",
    data: { authorization_url: "https://checkout.paystack.com/abc123", access_code: "abc123", reference: "ignored" },
  };
}

function signedWebhook(payload: unknown) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha512", env.PAYSTACK_SECRET_KEY!).update(raw).digest("hex");
  return request(server)
    .post("/api/paystack/webhook")
    .set("Content-Type", "application/json")
    .set("x-paystack-signature", signature)
    .send(raw);
}

function chargeSuccess(reference: string, amountKobo: number) {
  return {
    event: "charge.success",
    data: { reference, status: "success", amount: amountKobo, currency: "NGN", paid_at: "2026-11-03T10:00:00.000Z" },
  };
}

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
    .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: TUITION_KOBO });
  await request(server)
    .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
    .set("Authorization", `Bearer ${adminToken}`);
  const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });

  return { adminToken, parentToken, student, obligation };
}

async function initialize(token: string, obligationId: string, body: object = {}) {
  return request(server)
    .post(`/api/fee-obligations/${obligationId}/paystack/initialize`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("Paystack initialize", () => {
  it("opens a checkout for the full outstanding balance by default and records a PENDING transaction", async () => {
    const { parentToken, obligation, student } = await setupLinkedObligation();
    const fetchSpy = stubPaystack({ initialize: checkoutResponse() });

    const res = await initialize(parentToken, obligation.id);

    expect(res.status).toBe(201);
    expect(res.body.authorizationUrl).toBe("https://checkout.paystack.com/abc123");
    expect(res.body.amountKobo).toBe(TUITION_KOBO);

    const sent = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(sent).toMatchObject({
      email: "parent@test.local",
      amount: TUITION_KOBO,
      currency: "NGN",
      reference: res.body.reference,
      metadata: { feeObligationId: obligation.id, studentId: student.id },
    });

    const row = await prisma.paystackTransaction.findUniqueOrThrow({ where: { reference: res.body.reference } });
    expect(row.status).toBe("PENDING");
    expect(row.authorizationUrl).toBe("https://checkout.paystack.com/abc123");
    // Nothing lands in the bursar's queue for an unpaid checkout.
    expect(await prisma.payment.count()).toBe(0);
  });

  it("accepts a part-payment but refuses more than the outstanding balance, without calling Paystack", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    const fetchSpy = stubPaystack({ initialize: checkoutResponse() });

    const tooMuch = await initialize(parentToken, obligation.id, { amountKobo: TUITION_KOBO + 1 });
    expect(tooMuch.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();

    const part = await initialize(parentToken, obligation.id, { amountKobo: 2_000_000 });
    expect(part.status).toBe(201);
    expect(part.body.amountKobo).toBe(2_000_000);
  });

  it("409s on a waived obligation — nothing to pay", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    await prisma.feeObligation.update({ where: { id: obligation.id }, data: { status: "WAIVED" } });

    const res = await initialize(parentToken, obligation.id);
    expect(res.status).toBe(409);
  });

  it("502s and marks the transaction FAILED when Paystack refuses", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: { status: false, message: "Invalid key" }, initializeStatus: 401 });

    const res = await initialize(parentToken, obligation.id);
    expect(res.status).toBe(502);
    const row = await prisma.paystackTransaction.findFirstOrThrow({ where: { feeObligationId: obligation.id } });
    expect(row.status).toBe("FAILED");
  });
});

describe("Paystack webhook", () => {
  it("credits a CONFIRMED Paystack payment with a receipt, marks the obligation PAID, and ignores a replay", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id);

    const first = await signedWebhook(chargeSuccess(checkout.reference, TUITION_KOBO));
    expect(first.status).toBe(200);
    const replay = await signedWebhook(chargeSuccess(checkout.reference, TUITION_KOBO));
    expect(replay.status).toBe(200);

    const payments = await prisma.payment.findMany({ include: { receipt: true } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: "PAYSTACK",
      status: "CONFIRMED",
      amountKobo: TUITION_KOBO,
      bankReference: checkout.reference,
      confirmedByUserId: null,
    });
    expect(payments[0]!.receipt).not.toBeNull();

    const updated = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PAID");
    const row = await prisma.paystackTransaction.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(row).toMatchObject({ status: "SUCCESS", paymentId: payments[0]!.id });
  });

  it("rejects a bad signature with 401 and credits nothing", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id);

    const res = await request(server)
      .post("/api/paystack/webhook")
      .set("Content-Type", "application/json")
      .set("x-paystack-signature", "00".repeat(64))
      .send(JSON.stringify(chargeSuccess(checkout.reference, TUITION_KOBO)));

    expect(res.status).toBe(401);
    expect(await prisma.payment.count()).toBe(0);
  });

  it("never credits a charge whose amount doesn't match the transaction", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id);

    const res = await signedWebhook(chargeSuccess(checkout.reference, 100));
    expect(res.status).toBe(200);
    expect(await prisma.payment.count()).toBe(0);
    const row = await prisma.paystackTransaction.findUniqueOrThrow({ where: { reference: checkout.reference } });
    expect(row.status).toBe("PENDING");
  });

  it("acknowledges an unknown reference without crediting anything", async () => {
    const res = await signedWebhook(chargeSuccess("FTN-NOT-OURS", TUITION_KOBO));
    expect(res.status).toBe(200);
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe("Paystack verify", () => {
  it("credits a successful charge on return from checkout, and a later webhook doesn't double-credit it", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id, { amountKobo: 2_000_000 });

    vi.restoreAllMocks();
    stubPaystack({
      verify: {
        status: true,
        message: "Verification successful",
        data: { reference: checkout.reference, status: "success", amount: 2_000_000, currency: "NGN", paid_at: null },
      },
    });

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/paystack/verify`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ reference: checkout.reference });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCESS");
    expect(res.body.payment).toMatchObject({ method: "PAYSTACK", status: "CONFIRMED", amountKobo: 2_000_000 });
    expect(res.body.payment.receipt.receiptNumber).toMatch(/^RCPT-/);

    await signedWebhook(chargeSuccess(checkout.reference, 2_000_000));
    expect(await prisma.payment.count()).toBe(1);

    const updated = await prisma.feeObligation.findUniqueOrThrow({ where: { id: obligation.id } });
    expect(updated.status).toBe("PARTIALLY_PAID");
  });

  it("leaves an abandoned checkout PENDING", async () => {
    const { parentToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id);

    vi.restoreAllMocks();
    stubPaystack({
      verify: {
        status: true,
        message: "Verification successful",
        data: { reference: checkout.reference, status: "abandoned", amount: TUITION_KOBO, currency: "NGN", paid_at: null },
      },
    });

    const res = await request(server)
      .post(`/api/fee-obligations/${obligation.id}/paystack/verify`)
      .set("Authorization", `Bearer ${parentToken}`)
      .send({ reference: checkout.reference });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "PENDING", payment: null });
  });

  it("404s for a reference that belongs to a different obligation", async () => {
    const { parentToken, adminToken, obligation } = await setupLinkedObligation();
    stubPaystack({ initialize: checkoutResponse() });
    const { body: checkout } = await initialize(parentToken, obligation.id);

    const otherStudent = await createBareStudent("ADM-002");
    const otherObligation = await prisma.feeObligation.create({
      data: {
        studentId: otherStudent.id,
        feeStructureId: obligation.feeStructureId,
        academicSessionId: obligation.academicSessionId,
        amountDueKobo: TUITION_KOBO,
        createdByUserId: obligation.createdByUserId,
      },
    });

    const res = await request(server)
      .post(`/api/fee-obligations/${otherObligation.id}/paystack/verify`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reference: checkout.reference });
    expect(res.status).toBe(404);
  });
});
