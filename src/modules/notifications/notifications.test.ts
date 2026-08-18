import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
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

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("fee reminder trigger", () => {
  it("notifies linked parents of outstanding obligations, skips fully-paid ones, and delivers via IN_APP + SMS/EMAIL", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");

    const owingStudent = await createBareStudent("ADM-001");
    const paidStudent = await createBareStudent("ADM-002");
    await enrollStudent(owingStudent.id, klass.id, session.id);
    await enrollStudent(paidStudent.id, klass.id, session.id);

    // Deliberately no phone set — createParent's underlying user only gets an
    // email (required at account-creation time for login). Phone is genuinely
    // optional, which is what makes the SMS-channel-failure case below real.
    const { parent: owingParent } = await createParent("owing-parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: owingParent.id, studentId: owingStudent.id, relationship: "MOTHER" },
    });

    const { parent: paidParent } = await createParent("paid-parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: paidParent.id, studentId: paidStudent.id, relationship: "FATHER" },
    });

    const structureRes = await request(app)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(app)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);

    // Fully pay off paidStudent's obligation.
    const paidObligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: paidStudent.id } });
    const payment = await request(app)
      .post(`/api/fee-obligations/${paidObligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(app).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    const triggerRes = await request(app)
      .post("/api/notifications/fee-reminders/trigger")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ academicSessionId: session.id });

    expect(triggerRes.status).toBe(200);
    // Exactly one reminder sent — to owingParent only, not paidParent.
    expect(triggerRes.body).toHaveLength(1);
    expect(triggerRes.body[0].recipientUserId).toBe(owingParent.userId);
    expect(triggerRes.body[0].type).toBe("FEE_REMINDER");

    const deliveries = await prisma.notificationDelivery.findMany({
      where: { notificationEventId: triggerRes.body[0].id },
    });
    const inApp = deliveries.find((d) => d.channel === "IN_APP");
    const sms = deliveries.find((d) => d.channel === "SMS");
    const email = deliveries.find((d) => d.channel === "EMAIL");

    expect(inApp?.status).toBe("DELIVERED");
    // No phone on file — that channel fails cleanly rather than silently dropping.
    expect(sms?.status).toBe("FAILED");
    expect(sms?.error).toBeTruthy();
    // Email is always present (required at account creation), so it succeeds.
    expect(email?.status).toBe("SENT");
  });
});

describe("payment confirmation notification", () => {
  it("automatically notifies the linked parent when a payment is confirmed", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const session = await createCurrentAcademicSession("2026/2027");
    const klass = await createClass("JSS1", "A");
    const student = await createBareStudent("ADM-001");
    await enrollStudent(student.id, klass.id, session.id);

    const { parent, token: parentToken } = await createParent("parent@test.local");
    await prisma.studentParent.create({
      data: { parentId: parent.id, studentId: student.id, relationship: "MOTHER" },
    });

    const structureRes = await request(app)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(app)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);
    const obligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: student.id } });

    const payment = await request(app)
      .post(`/api/fee-obligations/${obligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(app).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    const myNotifications = await request(app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${parentToken}`);

    expect(myNotifications.status).toBe(200);
    expect(myNotifications.body).toHaveLength(1);
    expect(myNotifications.body[0].type).toBe("PAYMENT_CONFIRMATION");
  });
});

describe("GET /api/notifications", () => {
  it("only returns the caller's own notifications", async () => {
    const { parent: parent1, token: token1 } = await createParent("parent1@test.local");
    const { token: token2 } = await createParent("parent2@test.local");

    await prisma.notificationEvent.create({
      data: {
        type: "ADMIN_GENERAL",
        recipientUserId: parent1.userId,
        subject: "Hello",
        body: "Just for parent1",
      },
    });

    const asParent1 = await request(app).get("/api/notifications").set("Authorization", `Bearer ${token1}`);
    expect(asParent1.body).toHaveLength(1);

    const asParent2 = await request(app).get("/api/notifications").set("Authorization", `Bearer ${token2}`);
    expect(asParent2.body).toHaveLength(0);
  });
});
