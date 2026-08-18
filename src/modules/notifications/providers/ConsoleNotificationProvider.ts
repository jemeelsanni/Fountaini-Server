import { logger } from "../../../config/logger.js";
import type { NotificationProvider, SendMessageInput, SendMessageResult } from "./NotificationProvider.js";

/// MVP stand-in until a real SMS/email/WhatsApp vendor is chosen (explicitly
/// undecided per the PRD). Logs instead of sending. Swapping this for a real
/// provider later means writing one new class implementing
/// NotificationProvider and changing one line in notifications.service.ts —
/// nothing else in the codebase references a vendor.
export class ConsoleNotificationProvider implements NotificationProvider {
  readonly name = "console";

  send(input: SendMessageInput): Promise<SendMessageResult> {
    logger.info(
      { channel: input.channel, recipient: input.recipient, subject: input.subject },
      "[console notification provider] would send message",
    );
    return Promise.resolve({ status: "SENT", providerMessageId: `console-${Date.now()}` });
  }
}
