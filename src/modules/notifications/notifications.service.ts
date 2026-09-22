import type { NotificationChannel, NotificationType } from "../../../generated/prisma/index.js";
import { env } from "../../config/env.js";
import { prisma } from "../../db/client.js";
import { ConsoleNotificationProvider } from "./providers/ConsoleNotificationProvider.js";
import type { NotificationProvider } from "./providers/NotificationProvider.js";
import { ResendNotificationProvider } from "./providers/ResendNotificationProvider.js";

// The only place a concrete provider is chosen, selected by
// NOTIFICATION_PROVIDER — "console" (the dev/test default) just logs, so
// env.ts's superRefine refuses to start the app in production with
// anything other than "resend" selected here.
const provider: NotificationProvider =
  env.NOTIFICATION_PROVIDER === "resend" ? new ResendNotificationProvider() : new ConsoleNotificationProvider();

/// Seed-only kill switch, checked by the four CREDENTIALS_ISSUED call sites
/// (staff.service.ts::deliverStaffCredentials, parents.service.ts::
/// deliverParentCredentials, students.service.ts::issueFirstLoginForStudent
/// and ::reissueCredentialsForStudent) rather than inside createNotification
/// itself: this skips those calls entirely — no NotificationEvent, no
/// NotificationDelivery row, one fewer $transaction on an already-slow
/// link — rather than creating the rows and just not sending, which
/// wouldn't address the thing that was actually failing (the write, not
/// the send). Scoped to this one notification type on purpose, not a
/// blanket switch: FEE_REMINDER/PAYMENT_CONFIRMATION/ADMIN_GENERAL
/// notifications the seed also creates (e.g. its own "a handful of
/// notifications" scenario) are unaffected.
export const suppressCredentialNotifications = env.SUPPRESS_CREDENTIAL_NOTIFICATIONS === "true";

interface CreateNotificationInput {
  type: NotificationType;
  recipientUserId: string;
  subject: string;
  body: string;
  channels: NotificationChannel[];
  relatedEntityType?: string;
  relatedEntityId?: string;
}

async function resolveRecipientAddress(userId: string, channel: NotificationChannel): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return null;
  }
  return channel === "EMAIL" ? user.email : user.phone;
}

export async function createNotification(input: CreateNotificationInput) {
  const channels = [...new Set<NotificationChannel>([...input.channels, "IN_APP"])];

  // Atomic: the event and every channel's PENDING delivery placeholder are
  // created together, in one transaction — a crash (or, in tests, a
  // resetDb() truncate) between "event exists" and "its deliveries exist"
  // used to be possible, leaving an event the system believes was
  // delivered with no delivery record for it at all. This is a real
  // production correctness gap, not only the test race it also happened to
  // cause (see docs/concurrency.md's 2026-09-19 entries) — same family as
  // this codebase's other read-then-write races. The actual send (network
  // I/O, per channel, below) deliberately stays OUTSIDE this transaction:
  // holding a DB transaction open for the duration of an external HTTP call
  // is its own anti-pattern, and a crash mid-send now just leaves an
  // existing delivery row at PENDING rather than erasing it entirely.
  const { event, pendingDeliveries } = await prisma.$transaction(async (tx) => {
    const event = await tx.notificationEvent.create({
      data: {
        type: input.type,
        recipientUserId: input.recipientUserId,
        subject: input.subject,
        body: input.body,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
      },
    });

    const pendingDeliveries = await Promise.all(
      channels.map((channel) =>
        tx.notificationDelivery.create({
          data: { notificationEventId: event.id, channel, status: "PENDING" },
        }),
      ),
    );

    return { event, pendingDeliveries };
  });

  const deliveries = await Promise.all(
    pendingDeliveries.map(async (delivery) => {
      const channel = delivery.channel;

      // In-app "delivery" is just the row existing — no external dispatch needed.
      if (channel === "IN_APP") {
        return prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: { status: "DELIVERED", deliveredAt: new Date() },
        });
      }

      const recipient = await resolveRecipientAddress(input.recipientUserId, channel);
      if (!recipient) {
        return prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: "FAILED",
            error: "No contact address on file for this channel",
            attemptedAt: new Date(),
          },
        });
      }

      const result = await provider.send({ channel, recipient, subject: input.subject, body: input.body });
      return prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: result.status,
          providerName: provider.name,
          providerMessageId: result.providerMessageId,
          error: result.error,
          attemptedAt: new Date(),
        },
      });
    }),
  );

  return { event, deliveries };
}

export function listNotificationsForUser(userId: string) {
  return prisma.notificationEvent.findMany({
    where: { recipientUserId: userId },
    include: { deliveries: true },
    orderBy: { createdAt: "desc" },
  });
}

/// Idempotent by design: re-marking an already-read notification is a 200,
/// not a 409 or a no-op error — the caller wanted it read, and it already
/// is. `readAt: null` in the WHERE guard means the write only actually
/// happens (and only the FIRST read timestamp is ever kept) when it isn't
/// already set; either way the current row is returned. Ownership (is this
/// the caller's own notification) is enforced by the route's own
/// requireScope gate, not here.
export async function markNotificationRead(id: string) {
  await prisma.notificationEvent.updateMany({
    where: { id, readAt: null },
    data: { readAt: new Date() },
  });
  return prisma.notificationEvent.findUniqueOrThrow({ where: { id } });
}

export async function markAllNotificationsRead(userId: string) {
  const { count } = await prisma.notificationEvent.updateMany({
    where: { recipientUserId: userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { markedCount: count };
}

/// Finds every fee obligation with a positive outstanding balance and sends a
/// FEE_REMINDER to each linked parent. Manually triggered for MVP (see
/// POST /api/notifications/fee-reminders/trigger) — periodic scheduling is a
/// deployment-level decision (cron, external scheduler hitting this route)
/// deliberately not built here.
export async function triggerFeeReminders(academicSessionId?: string) {
  const obligations = await prisma.feeObligation.findMany({
    where: { status: { in: ["PENDING", "PARTIALLY_PAID"] }, academicSessionId },
    include: {
      student: { include: { parents: { include: { parent: true } } } },
      feeStructure: true,
      payments: { where: { status: "CONFIRMED" } },
    },
  });

  const sent = [];
  for (const obligation of obligations) {
    const totalPaidKobo = obligation.payments.reduce((sum, p) => sum + p.amountKobo, 0);
    const outstandingKobo = obligation.amountDueKobo - totalPaidKobo;
    if (outstandingKobo <= 0) {
      continue;
    }

    for (const link of obligation.student.parents) {
      const { event } = await createNotification({
        type: "FEE_REMINDER",
        recipientUserId: link.parent.userId,
        subject: `Outstanding fee reminder: ${obligation.feeStructure.name}`,
        body: `${obligation.student.firstName} ${obligation.student.lastName} (${obligation.student.admissionNumber}) has an outstanding balance of ₦${(outstandingKobo / 100).toFixed(2)} for ${obligation.feeStructure.name}.`,
        channels: ["SMS", "EMAIL"],
        relatedEntityType: "FeeObligation",
        relatedEntityId: obligation.id,
      });
      sent.push(event);
    }
  }

  return sent;
}
