import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { AppError } from "../../errors/AppError.js";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

/// Paystack's own transaction states, as returned by /transaction/verify and
/// carried in webhook payloads. Only "success" credits anything; "failed"
/// and "reversed" are final; everything else ("abandoned", "ongoing",
/// "pending", ...) can still turn into a success later, so it's left alone.
export interface PaystackTransactionData {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at: string | null;
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

function requireSecretKey(): string {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw AppError.serviceUnavailable("Online payment is not configured on this server");
  }
  return env.PAYSTACK_SECRET_KEY;
}

/// Lets a caller fail fast with 503 before doing any work of its own (e.g.
/// writing a PaystackTransaction row that could never be paid).
export function assertConfigured(): void {
  requireSecretKey();
}

/// Thin fetch wrapper — Paystack's API is three calls, not worth an SDK
/// dependency. Any non-2xx or `status: false` envelope becomes a 502:
/// it's the upstream that failed, not the caller's request. Logs Paystack's
/// own message (never the secret key, which only ever travels in the
/// Authorization header).
async function paystackRequest<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<T> {
  const secretKey = requireSecretKey();
  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    logger.error({ err, path }, "Paystack request failed to send");
    throw AppError.paymentProviderError("Could not reach the payment provider — please try again shortly");
  }

  const envelope = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;
  if (!response.ok || !envelope?.status) {
    logger.error({ path, httpStatus: response.status, message: envelope?.message }, "Paystack request rejected");
    throw AppError.paymentProviderError("The payment provider rejected the request — please try again shortly");
  }
  return envelope.data;
}

export function initializeTransaction(input: {
  email: string;
  amountKobo: number;
  reference: string;
  metadata: Record<string, string>;
}) {
  return paystackRequest<{ authorization_url: string; access_code: string; reference: string }>(
    "/transaction/initialize",
    {
      method: "POST",
      body: {
        email: input.email,
        amount: input.amountKobo,
        currency: "NGN",
        reference: input.reference,
        callback_url: env.PAYSTACK_CALLBACK_URL,
        metadata: input.metadata,
      },
    },
  );
}

export function verifyTransaction(reference: string) {
  return paystackRequest<PaystackTransactionData>(`/transaction/verify/${encodeURIComponent(reference)}`, {
    method: "GET",
  });
}

/// x-paystack-signature is HMAC-SHA512 of the raw request body, keyed with
/// the secret key. Constant-time comparison; a missing or malformed header
/// is simply "not valid", never an exception.
export function isValidWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secretKey = requireSecretKey();
  if (!signature) {
    return false;
  }
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
