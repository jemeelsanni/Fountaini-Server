/// The one boundary any real SMS/email/WhatsApp vendor integration touches.
/// Nothing outside this file (or a future concrete provider implementing it)
/// should know a vendor's name, SDK, or API shape.
export interface SendMessageInput {
  channel: "SMS" | "EMAIL" | "WHATSAPP";
  recipient: string;
  subject: string;
  body: string;
}

export interface SendMessageResult {
  status: "SENT" | "FAILED";
  providerMessageId?: string;
  /// The real vendor error message, un-redacted, un-truncated — this is
  /// still just an in-memory value at this point, same as a notification's
  /// own `body`. createNotification (notifications.service.ts) is the one
  /// place that decides how much of it, if any, is safe to persist (see
  /// categorizeProviderError there) — a provider should never pre-emptively
  /// sanitize or shorten this itself.
  error?: string;
}

export interface NotificationProvider {
  readonly name: string;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
