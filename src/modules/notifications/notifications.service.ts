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
  const event = await prisma.notificationEvent.create({
    data: {
      type: input.type,
      recipientUserId: input.recipientUserId,
      subject: input.subject,
      body: input.body,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
    },
  });

  const channels = [...new Set<NotificationChannel>([...input.channels, "IN_APP"])];

  const deliveries = await Promise.all(
    channels.map(async (channel) => {
      const delivery = await prisma.notificationDelivery.create({
        data: { notificationEventId: event.id, channel, status: "PENDING" },
      });

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
