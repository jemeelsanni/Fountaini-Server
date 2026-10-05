import {
  Prisma,
  type NotificationChannel,
  type NotificationDeliveryStatus,
  type NotificationErrorCategory,
  type NotificationType,
} from "../../../generated/prisma/index.js";
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
  /// True for a body that carries a real secret — a temporary password or a
  /// password-reset token. The real `body` above is still what's handed to
  /// the provider below (the actual email must carry the real value) but
  /// never what's persisted: PERSISTED_SENSITIVE_BODY is written to
  /// NotificationEvent.body instead, so every read path (GET
  /// /api/notifications included) is safe by construction, with nothing to
  /// remember to redact per-route. See the column's own comment in
  /// schema.prisma.
  sensitive?: boolean;
}

const PERSISTED_SENSITIVE_BODY = "[redacted — sensitive content, not stored]";

const ERROR_MESSAGE_MAX_LENGTH = 200;
// A real per-send API error is normally a short, specific sentence or two.
// Nothing beyond this is assumed to be a legitimate error description —
// treated as implausible and dropped by the safety check below rather than
// truncated and stored anyway.
const ERROR_MESSAGE_PLAUSIBLE_LENGTH = 1000;

/// Resend's own structured error codes (ErrorResponse.name — see
/// node_modules/resend/dist/index.d.mts's RESEND_ERROR_CODE_KEY, the
/// installed SDK's own type, read directly rather than guessed at from
/// docs) mapped to this app's five categories. Everything NOT listed here
/// but still a recognized Resend code (missing_api_key, invalid_api_key,
/// invalid_region, application_error, internal_server_error, ...) is a
/// vendor/account-level problem, never about this specific recipient —
/// PROVIDER_ERROR.
///
/// Resend has no "invalid_to_address"-shaped code in this version's
/// taxonomy — the three mapped to INVALID_RECIPIENT below are a judgment
/// call, not a vendor-documented 1:1 mapping: in a send() call shaped like
/// this app's (channel/recipient/subject/body, with subject+body always
/// from a controlled template and `from` a fixed, pre-verified config
/// value — see env.ts's EMAIL_FROM_ADDRESS), the recipient address is the
/// only part of the payload that varies with per-user data and could
/// plausibly be malformed, so a generic "something about your parameters
/// is wrong" code most often means that in practice here.
const RESEND_ERROR_CODE_CATEGORY: Partial<Record<string, NotificationErrorCategory>> = {
  daily_quota_exceeded: "QUOTA_EXCEEDED",
  monthly_quota_exceeded: "QUOTA_EXCEEDED",
  rate_limit_exceeded: "RATE_LIMITED",
  invalid_parameter: "INVALID_RECIPIENT",
  validation_error: "INVALID_RECIPIENT",
  missing_required_field: "INVALID_RECIPIENT",
};

/// Structured signal first: a recognized vendor error code, or (lacking
/// one) an HTTP status that itself implies a category (429 => rate
/// limited) — this is categorizeProviderError's PRIMARY path. Returns null
/// when neither tells us anything, so the caller can fall back to
/// message-text matching.
function categorizeByStructuredFields(
  errorCode: string | undefined,
  statusCode: number | null | undefined,
): NotificationErrorCategory | null {
  if (errorCode) {
    return RESEND_ERROR_CODE_CATEGORY[errorCode] ?? "PROVIDER_ERROR";
  }
  if (statusCode === 429) {
    return "RATE_LIMITED";
  }
  return null;
}

/// Fallback only — for a provider (or a future, non-Resend one) that
/// returns no recognized structured code at all. Best-effort over the
/// patterns a vendor's documented error messages commonly use, not a
/// verified 1:1 match against anything. Order matters: more specific
/// checks first, PROVIDER_ERROR is the catch-all for "we got a real
/// error, just not one of the above."
function categorizeByMessage(message: string): NotificationErrorCategory {
  const lower = message.toLowerCase();
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "RATE_LIMITED";
  }
  if (lower.includes("quota") || lower.includes("daily limit") || lower.includes("usage limit")) {
    return "QUOTA_EXCEEDED";
  }
  if (
    lower.includes("invalid") &&
    (lower.includes("recipient") ||
      lower.includes("email") ||
      lower.includes("address") ||
      lower.includes("domain") ||
      lower.includes("to field"))
  ) {
    return "INVALID_RECIPIENT";
  }
  if (lower.includes("no contact address")) {
    return "INVALID_RECIPIENT";
  }
  return "PROVIDER_ERROR";
}

/// Decides both the normalized category AND whether the raw vendor message
/// is actually safe to persist at all — the deliveries view (and each
/// pending-activation row) needs to tell "wait, the cap will reset" apart
/// from "fix the address," which the raw message alone doesn't reliably
/// support (every provider phrases these differently). Category is
/// resolved structured-first (categorizeByStructuredFields), falling back
/// to message-text matching only when no recognized code or status came
/// back at all — text heuristics alone are brittle, per the report. The
/// raw `error` text itself is persisted only when it looks like an
/// ordinary API error description, not something that could be echoing
/// the notification's own (possibly `sensitive`) body back — this is a
/// defensive check, not a proven leak (nothing in Resend's documented
/// error shape echoes request content), but an unusually long message, or
/// one that literally contains the real body just sent, is treated as
/// untrustworthy to store verbatim. When unsure, the category is still
/// persisted — only the message is dropped.
export function categorizeProviderError(
  result: { error?: string; errorCode?: string; errorStatusCode?: number | null },
  realBodySent: string,
): { category: NotificationErrorCategory; error: string | null } {
  if (!result.error && !result.errorCode) {
    return { category: "UNKNOWN", error: null };
  }

  const category =
    categorizeByStructuredFields(result.errorCode, result.errorStatusCode) ??
    (result.error ? categorizeByMessage(result.error) : "UNKNOWN");

  if (!result.error) {
    return { category, error: null };
  }

  const looksLikeItCouldLeakTheBody =
    result.error.length > ERROR_MESSAGE_PLAUSIBLE_LENGTH ||
    (realBodySent.length > 20 && result.error.includes(realBodySent));
  if (looksLikeItCouldLeakTheBody) {
    return { category, error: null };
  }

  const error =
    result.error.length > ERROR_MESSAGE_MAX_LENGTH
      ? `${result.error.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
      : result.error;
  return { category, error };
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
        body: input.sensitive ? PERSISTED_SENSITIVE_BODY : input.body,
        sensitive: input.sensitive ?? false,
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
            errorCategory: "INVALID_RECIPIENT",
            attemptedAt: new Date(),
          },
        });
      }

      const result = await provider.send({ channel, recipient, subject: input.subject, body: input.body });
      const { category, error } =
        result.status === "FAILED" ? categorizeProviderError(result, input.body) : { category: null, error: null };
      return prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: result.status,
          providerName: provider.name,
          providerMessageId: result.providerMessageId,
          error,
          errorCategory: category,
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

export interface ListDeliveriesFilter {
  status?: NotificationDeliveryStatus;
  type?: NotificationType;
  channel?: NotificationChannel;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

// Same batched-lookup shape as fees.service.ts's resolveUserNames — one
// User.findMany, not N+1 — extended with `student` since a notification
// recipient can be a student directly (not just staff/parent), unlike a
// payment's recordedByUserId.
async function resolveRecipientNames(userIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: {
      id: true,
      staff: { select: { firstName: true, lastName: true } },
      parent: { select: { firstName: true, lastName: true } },
      student: { select: { firstName: true, lastName: true } },
    },
  });
  const names = new Map<string, string>();
  for (const user of users) {
    const person = user.staff ?? user.parent ?? user.student;
    names.set(user.id, person ? `${person.firstName} ${person.lastName}` : "Unknown");
  }
  return names;
}

/// The admin-facing counterpart to GET /api/notifications: that route is
/// self-scoped (a caller's own notifications only) and includes each
/// event's full body — this one is cross-user and deliberately never
/// selects `body` at all, sensitive or not. The chase list for "did this
/// credential email actually arrive" — see also listPendingActivation
/// (users.service.ts), which answers "who still hasn't signed in" using
/// this same delivery data.
///
/// `recipientAddress` is resolved from the User's CURRENT email/phone, not
/// a snapshot of the address the send actually went to — NotificationDelivery
/// doesn't persist one (see resolveRecipientAddress, above) and adding that
/// column is out of scope here; the two agree except in the rare case a
/// contact address changed after the send.
///
/// Summary counts intentionally ignore the `status` filter (but respect
/// type/channel/from/to) — filtering the list down to FAILED rows and
/// having the summary then only ever say "FAILED: N" would defeat the
/// point of a summary.
export async function listDeliveries(filter: ListDeliveriesFilter) {
  const dateRange =
    filter.from ?? filter.to ? { createdAt: { gte: filter.from, lte: filter.to } } : undefined;

  const summaryWhere: Prisma.NotificationDeliveryWhereInput = {
    channel: filter.channel,
    notificationEvent: { type: filter.type, ...dateRange },
  };
  const listWhere: Prisma.NotificationDeliveryWhereInput = { ...summaryWhere, status: filter.status };

  const [total, rows, statusCounts] = await Promise.all([
    prisma.notificationDelivery.count({ where: listWhere }),
    prisma.notificationDelivery.findMany({
      where: listWhere,
      select: {
        id: true,
        channel: true,
        status: true,
        error: true,
        errorCategory: true,
        attemptedAt: true,
        deliveredAt: true,
        createdAt: true,
        notificationEvent: {
          select: {
            type: true,
            recipientUserId: true,
            recipient: { select: { email: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    }),
    prisma.notificationDelivery.groupBy({ by: ["status"], where: summaryWhere, _count: true }),
  ]);

  const names = await resolveRecipientNames(rows.map((r) => r.notificationEvent.recipientUserId));

  const deliveries = rows.map((r) => ({
    id: r.id,
    notificationType: r.notificationEvent.type,
    channel: r.channel,
    recipientAddress:
      r.channel === "EMAIL" ? r.notificationEvent.recipient.email : r.notificationEvent.recipient.phone,
    recipientUserId: r.notificationEvent.recipientUserId,
    recipientName: names.get(r.notificationEvent.recipientUserId) ?? "Unknown",
    status: r.status,
    error: r.error,
    errorCategory: r.errorCategory,
    attemptedAt: r.attemptedAt,
    deliveredAt: r.deliveredAt,
    createdAt: r.createdAt,
  }));

  const summary: Record<string, number> = { PENDING: 0, SENT: 0, FAILED: 0, DELIVERED: 0 };
  for (const row of statusCounts) {
    summary[row.status] = row._count;
  }

  return { deliveries, total, page: filter.page, pageSize: filter.pageSize, summary };
}
