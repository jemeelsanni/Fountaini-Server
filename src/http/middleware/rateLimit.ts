import { rateLimit } from "express-rate-limit";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/AppError.js";

/// express-rate-limit's default key generator reads `req.ip`, which Express
/// only trusts the `X-Forwarded-For` header for once `app.set("trust
/// proxy", ...)` is configured (see app.ts) — without that, every request
/// behind Railway's edge proxy resolves to the *proxy's* IP, and this whole
/// module buckets the entire school as one client. That setting is what
/// makes these limiters correct, not anything in this file itself; the
/// library also refuses to start (throws at first request) if it detects
/// `req.ip` looks unset/misconfigured, as a built-in guard against exactly
/// this misconfiguration shipping unnoticed.
///
/// Same JSON error envelope as every other rejection in this API (see
/// AppError/app.ts's error handler) rather than express-rate-limit's own
/// default plaintext response — a 429 should look like every other error
/// to a client parsing responses.
function rateLimitHandler(_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }) {
  const err = new AppError(429, "TOO_MANY_REQUESTS", "Too many requests. Please try again later.");
  res.status(err.statusCode).json({ error: { code: err.code, message: err.message, details: err.details } });
}

/// The three limiters below are unenforced under NODE_ENV=test — same
/// reasoning as password.ts's test-only argon2 cost reduction: this module
/// exists to protect production traffic, and the functional test suite
/// legitimately calls POST /api/auth/login (etc.) far more than 10 times
/// per file (every fixture that needs a token does), which has nothing to
/// do with whether the *rate-limiting logic itself* is correct. That's
/// verified on its own terms by a small, isolated limiter built directly in
/// rateLimit.test.ts — not gated by this flag, so it still exercises real
/// enforcement under `vitest run`.
const skipInTest = () => env.NODE_ENV === "test";

/// POST /api/auth/login — brute-force protection. Keyed by IP, not by the
/// attempted email: an attacker rotating target emails against one IP is
/// exactly the case this needs to catch, and an IP-keyed limit doesn't stop
/// a legitimate user occasionally mistyping their own password.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: rateLimitHandler,
});

/// POST /api/auth/forgot-password — each request triggers a real
/// notification send (see auth.service.ts's requestPasswordReset), so this
/// is deliberately stricter than login: both a brute-force guard and a
/// spam/cost guard.
export const passwordResetRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: rateLimitHandler,
});

/// POST /api/admission-enquiries — the one write route with no auth at all
/// reachable by anyone on the internet. Generous enough for a real
/// prospective family (who would only ever submit this once or twice) while
/// bounding automated/spam submission volume.
export const admissionEnquiryRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  handler: rateLimitHandler,
});
