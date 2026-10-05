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
  /// A short, vendor-defined machine code for the failure, when the vendor's
  /// API actually returns one (e.g. Resend's `error.name`, a fixed
  /// enumerated string like "rate_limit_exceeded" — see
  /// node_modules/resend's own RESEND_ERROR_CODE_KEY type). This is the
  /// PRIMARY signal categorizeProviderError uses; message-text matching is
  /// only a fallback for providers (or errors) that don't supply one.
  errorCode?: string;
  /// The HTTP status code the vendor's API responded with, if any — a
  /// secondary structured signal (e.g. 429 implies rate-limiting even
  /// without a recognized errorCode).
  errorStatusCode?: number | null;
}

export interface NotificationProvider {
  readonly name: string;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
