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
  error?: string;
}

export interface NotificationProvider {
  readonly name: string;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}
