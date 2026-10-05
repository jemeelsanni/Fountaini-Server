import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { prisma } from "../../db/client.js";
import {
  createAdmin,
  createBareStudent,
  createBursar,
  createClass,
  createCurrentAcademicSession,
  createParent,
  createStudentWithLogin,
  createTeacher,
  enrollStudent,
} from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { waitForNotification } from "../../test/waitForNotification.js";
import { categorizeProviderError } from "./notifications.service.js";

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

    const structureRes = await request(server)
      .post("/api/fee-structures")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Tuition", category: "TUITION", classId: klass.id, academicSessionId: session.id, amountKobo: 5_000_000 });
    await request(server)
      .post(`/api/fee-structures/${structureRes.body.id}/generate-obligations`)
      .set("Authorization", `Bearer ${adminToken}`);

    // Fully pay off paidStudent's obligation.
    const paidObligation = await prisma.feeObligation.findFirstOrThrow({ where: { studentId: paidStudent.id } });
    const payment = await request(server)
      .post(`/api/fee-obligations/${paidObligation.id}/payments`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    const triggerRes = await request(server)
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
    expect(sms?.errorCategory).toBe("INVALID_RECIPIENT");
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
      .send({ amountKobo: 5_000_000, paymentDate: "2026-09-10" });
    await request(server).post(`/api/payments/${payment.body.id}/confirm`).set("Authorization", `Bearer ${adminToken}`);

    // confirmPayment() fires the notification without awaiting it (a slow or
    // failing notification must not delay or fail the confirm response) —
    // poll rather than assume it's already landed by the time the request
    // above returns.
    await waitForNotification(parent.userId, "Payment", payment.body.id as string);

    const myNotifications = await request(server)
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

    const asParent1 = await request(server).get("/api/notifications").set("Authorization", `Bearer ${token1}`);
    expect(asParent1.body).toHaveLength(1);

    const asParent2 = await request(server).get("/api/notifications").set("Authorization", `Bearer ${token2}`);
    expect(asParent2.body).toHaveLength(0);
  });
});

describe("PATCH /api/notifications/:id/read", () => {
  it("marks a notification read, is idempotent on a second call, and denies another user's notification", async () => {
    const { parent: parent1, token: token1 } = await createParent("parent1@test.local");
    const { token: token2 } = await createParent("parent2@test.local");

    const notification = await prisma.notificationEvent.create({
      data: {
        type: "ADMIN_GENERAL",
        recipientUserId: parent1.userId,
        subject: "Hello",
        body: "Body",
      },
    });

    const first = await request(server)
      .patch(`/api/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${token1}`);
    expect(first.status).toBe(200);
    expect(first.body.readAt).not.toBeNull();
    const firstReadAt = first.body.readAt as string;

    const second = await request(server)
      .patch(`/api/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${token1}`);
    expect(second.status).toBe(200);
    // Idempotent: the original readAt is preserved, not bumped.
    expect(second.body.readAt).toBe(firstReadAt);

    const asOtherUser = await request(server)
      .patch(`/api/notifications/${notification.id}/read`)
      .set("Authorization", `Bearer ${token2}`);
    expect([403, 404]).toContain(asOtherUser.status);
  });
});

describe("POST /api/notifications/read-all", () => {
  it("marks every one of the caller's own unread notifications read, and none of another user's", async () => {
    const { parent: parent1, token: token1 } = await createParent("parent1@test.local");
    const { parent: parent2 } = await createParent("parent2@test.local");

    await prisma.notificationEvent.createMany({
      data: [
        { type: "ADMIN_GENERAL", recipientUserId: parent1.userId, subject: "A", body: "A" },
        { type: "ADMIN_GENERAL", recipientUserId: parent1.userId, subject: "B", body: "B" },
        { type: "ADMIN_GENERAL", recipientUserId: parent2.userId, subject: "C", body: "C" },
      ],
    });

    const res = await request(server).post("/api/notifications/read-all").set("Authorization", `Bearer ${token1}`);
    expect(res.status).toBe(200);
    expect(res.body.markedCount).toBe(2);

    const unreadForParent2 = await prisma.notificationEvent.count({
      where: { recipientUserId: parent2.userId, readAt: null },
    });
    expect(unreadForParent2).toBe(1);
  });
});

describe("GET /api/notifications/deliveries", () => {
  it("rejects TEACHER, BURSAR, PARENT and STUDENT with 403", async () => {
    const { token: teacherToken } = await createTeacher("teacher@test.local");
    const { token: bursarToken } = await createBursar("bursar@test.local");
    const { token: parentToken } = await createParent("parent@test.local");
    const { token: studentToken } = await createStudentWithLogin("student@test.local", "FIA/2026/001");

    for (const token of [teacherToken, bursarToken, parentToken, studentToken]) {
      const res = await request(server)
        .get("/api/notifications/deliveries")
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it("lists a failed credential delivery with its status and error, with no body key on any row", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent } = await createParent("parent@test.local");

    const event = await prisma.notificationEvent.create({
      data: {
        type: "CREDENTIALS_ISSUED",
        recipientUserId: parent.userId,
        subject: "Your school portal login",
        body: "[redacted — sensitive content, not stored]",
        sensitive: true,
      },
    });
    await prisma.notificationDelivery.create({
      data: {
        notificationEventId: event.id,
        channel: "EMAIL",
        status: "FAILED",
        error: "Daily send limit reached",
        attemptedAt: new Date(),
      },
    });

    const res = await request(server)
      .get("/api/notifications/deliveries")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);
    const row = res.body.deliveries[0];
    expect(row.status).toBe("FAILED");
    expect(row.error).toBe("Daily send limit reached");
    expect(row.notificationType).toBe("CREDENTIALS_ISSUED");
    expect(row.recipientUserId).toBe(parent.userId);
    expect(row.recipientName).toBe("Test Parent");
    expect(row).not.toHaveProperty("body");
    expect(res.body.summary.FAILED).toBe(1);
  });

  it("filters by status, type and channel", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    const { parent } = await createParent("parent@test.local");

    const sent = await prisma.notificationEvent.create({
      data: { type: "ADMIN_GENERAL", recipientUserId: parent.userId, subject: "A", body: "A" },
    });
    await prisma.notificationDelivery.create({
      data: { notificationEventId: sent.id, channel: "EMAIL", status: "SENT", attemptedAt: new Date() },
    });

    const failed = await prisma.notificationEvent.create({
      data: { type: "CREDENTIALS_ISSUED", recipientUserId: parent.userId, subject: "B", body: "B", sensitive: true },
    });
    await prisma.notificationDelivery.create({
      data: { notificationEventId: failed.id, channel: "EMAIL", status: "FAILED", error: "x", attemptedAt: new Date() },
    });

    const byStatus = await request(server)
      .get("/api/notifications/deliveries?status=FAILED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byStatus.body.deliveries).toHaveLength(1);
    expect(byStatus.body.deliveries[0].status).toBe("FAILED");
    // Summary ignores the status filter — both rows still counted.
    expect(byStatus.body.summary.SENT + byStatus.body.summary.FAILED).toBe(2);

    const byType = await request(server)
      .get("/api/notifications/deliveries?type=CREDENTIALS_ISSUED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byType.body.deliveries).toHaveLength(1);
    expect(byType.body.deliveries[0].notificationType).toBe("CREDENTIALS_ISSUED");

    const byChannel = await request(server)
      .get("/api/notifications/deliveries?channel=IN_APP")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(byChannel.body.deliveries).toHaveLength(0);
  });
});

describe("sensitive notification bodies are never persisted in plaintext", () => {
  it("CREDENTIALS_ISSUED: the persisted body is the fixed placeholder, not the real temporary password", async () => {
    const { token: adminToken } = await createAdmin("admin@test.local");
    await createCurrentAcademicSession("2026/2027");

    const res = await request(server)
      .post("/api/staff")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "TEACHER", email: "newteacher@test.local", firstName: "New", lastName: "Teacher" });
    expect(res.status).toBe(201);

    const event = await waitForNotification(res.body.userId as string, "Staff", res.body.id as string);
    expect(event).not.toBeNull();
    expect(event?.sensitive).toBe(true);
    expect(event?.body).toBe("[redacted — sensitive content, not stored]");
  });

  it("PASSWORD_RESET: the persisted body is the fixed placeholder, not the real raw token", async () => {
    const { parent } = await createParent("resetme@test.local");

    const res = await request(server)
      .post("/api/auth/forgot-password")
      .send({ identifier: "resetme@test.local" });
    expect(res.status).toBe(204);

    const event = await prisma.notificationEvent.findFirst({
      where: { recipientUserId: parent.userId, type: "PASSWORD_RESET" },
      orderBy: { createdAt: "desc" },
    });
    expect(event).not.toBeNull();
    expect(event?.sensitive).toBe(true);
    expect(event?.body).toBe("[redacted — sensitive content, not stored]");

    // The real token is still hashed, stored separately, and still usable —
    // scrubbing the notification body must not break the reset flow itself.
    const resetToken = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: parent.userId } });
    expect(resetToken.tokenHash).not.toBe(event?.body);
  });
});

describe("categorizeProviderError", () => {
  it("classifies rate-limit, quota, and invalid-recipient messages distinctly, with a PROVIDER_ERROR catch-all", () => {
    expect(categorizeProviderError("Rate limit exceeded, please slow down", "body").category).toBe("RATE_LIMITED");
    expect(categorizeProviderError("Too many requests in a short period", "body").category).toBe("RATE_LIMITED");
    expect(categorizeProviderError("Daily quota exceeded for this account", "body").category).toBe(
      "QUOTA_EXCEEDED",
    );
    expect(categorizeProviderError("Invalid recipient email address", "body").category).toBe("INVALID_RECIPIENT");
    expect(categorizeProviderError("The `to` field contains an invalid address", "body").category).toBe(
      "INVALID_RECIPIENT",
    );
    expect(categorizeProviderError("Some unrecognized vendor failure", "body").category).toBe("PROVIDER_ERROR");
  });

  it("returns UNKNOWN with no error text when there is no message at all", () => {
    const result = categorizeProviderError(undefined, "the real body");
    expect(result).toEqual({ category: "UNKNOWN", error: null });
  });

  it("truncates a long-but-safe message to ~200 characters while still persisting its category", () => {
    const longMessage = `Invalid recipient: ${"x".repeat(300)}`;
    const result = categorizeProviderError(longMessage, "unrelated body");
    expect(result.category).toBe("INVALID_RECIPIENT");
    expect(result.error).not.toBeNull();
    expect(result.error!.length).toBeLessThanOrEqual(201); // 200 chars + the ellipsis
  });

  it("drops the message (category only) when it contains the real body that was sent", () => {
    const realBody = "Temporary password: SOME-REAL-SECRET-VALUE-0123456789";
    const suspiciousMessage = `Delivery failed for message with content: ${realBody}`;
    const result = categorizeProviderError(suspiciousMessage, realBody);
    expect(result.error).toBeNull();
    // Category is still computed — pattern-matching a string can't itself leak anything.
    expect(result.category).not.toBeNull();
  });

  it("drops an implausibly long message (category only), even without containing the real body", () => {
    const result = categorizeProviderError("x".repeat(5000), "a short, unrelated body");
    expect(result.error).toBeNull();
    expect(result.category).toBe("PROVIDER_ERROR");
  });
});
