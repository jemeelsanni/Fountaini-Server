import { Resend } from "resend";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import type { NotificationProvider, SendMessageInput, SendMessageResult } from "./NotificationProvider.js";

/// Sends EMAIL-channel notifications through Resend, from a verified
/// fountaini.academy sending address. env.ts's superRefine guarantees
/// RESEND_API_KEY is set whenever this class is actually selected
/// (NOTIFICATION_PROVIDER=resend), so there's no redundant check of it
/// here. SMS/WHATSAPP aren't wired to any vendor yet (see
/// ConsoleNotificationProvider) — this provider fails those channels
/// explicitly rather than silently dropping them, so a caller can tell the
/// difference between "no SMS vendor chosen yet" and "the email actually
/// sent."
///
/// Never logs the message subject or body: a password reset link/token is
/// a single-use credential, and this is the one provider whose logs are a
/// real production log stream, not a developer's terminal.
export class ResendNotificationProvider implements NotificationProvider {
  readonly name = "resend";
  private readonly client: Resend;

  constructor() {
    this.client = new Resend(env.RESEND_API_KEY);
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.channel !== "EMAIL") {
      return { status: "FAILED", error: `ResendNotificationProvider cannot send on channel ${input.channel}` };
    }

    const { data, error } = await this.client.emails.send({
      from: env.EMAIL_FROM_ADDRESS,
      to: input.recipient,
      subject: input.subject,
      text: input.body,
    });

    if (error || !data) {
      logger.error({ err: error, recipient: input.recipient, channel: input.channel }, "Resend send failed");
      return { status: "FAILED", error: "Failed to send email" };
    }

    return { status: "SENT", providerMessageId: data.id };
  }
}
