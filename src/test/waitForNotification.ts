import { prisma } from "../db/client.js";

/// confirmPayment() fires notifyPaymentConfirmed() without awaiting it before
/// the response returns (deliberately — a slow/failing notification must
/// never delay or fail an otherwise-successful payment confirmation). A test
/// that queries notifications immediately after the HTTP call returns can
/// race that write. Poll briefly instead of assuming the row already landed.
export async function waitForNotification(
  recipientUserId: string,
  relatedEntityType: string,
  relatedEntityId: string,
  timeoutMs = 2000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = await prisma.notificationEvent.findFirst({
      where: { recipientUserId, relatedEntityType, relatedEntityId },
    });
    if (entry) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}
