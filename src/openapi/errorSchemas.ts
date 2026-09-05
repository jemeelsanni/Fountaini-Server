import { z } from "zod";
import "./zodSetup.js";

/// Mirrors app.ts's global error handler exactly:
/// res.status(err.statusCode).json({ error: { code, message, details } }).
/// One envelope shape for every error response in this API — only the
/// `code` literal (and whether `details` is actually present) varies by
/// status, so each of the schemas below is this same shape with `code`
/// narrowed to the one value AppError actually sets for that status (see
/// src/errors/AppError.ts's own static constructors, which is what makes
/// this narrowing correct rather than aspirational).
function errorSchema(name: string, code: string, description: string) {
  return z
    .object({
      error: z.object({
        code: z.literal(code),
        message: z.string(),
        details: z.unknown().optional(),
      }),
    })
    .openapi(name, { description });
}

export const ValidationErrorSchema = errorSchema(
  "ValidationError",
  "BAD_REQUEST",
  "The request body/params/query failed schema validation, or violated a business rule " +
    "(e.g. an invalid state transition, a field that must reference an existing related record).",
);

export const UnauthorizedErrorSchema = errorSchema(
  "UnauthorizedError",
  "UNAUTHORIZED",
  "The Authorization header is missing or the access token is invalid/expired — or, for " +
    "login/refresh specifically, the credentials or refresh token themselves were rejected.",
);

export const ForbiddenErrorSchema = errorSchema(
  "ForbiddenError",
  "FORBIDDEN",
  "Authenticated, but not permitted to perform this action — the caller's role(s), or their " +
    "relationship to the specific resource, don't satisfy this route's guard.",
);

/// A distinct code from ForbiddenError on purpose: "this account holds no
/// roles at all" is an account-provisioning problem, not an ordinary
/// per-action permission failure — see AppError.noRolesAssigned()'s own
/// comment. Only ever returned by login/refresh (see errorResponses.ts).
export const NoRolesAssignedErrorSchema = errorSchema(
  "NoRolesAssignedError",
  "NO_ROLES_ASSIGNED",
  "This account authenticated successfully but holds no roles at all, so no access token was " +
    "issued. Distinct from an ordinary permission failure — this is an account-provisioning " +
    "problem an admin needs to fix, not something the caller can route around.",
);

export const NotFoundErrorSchema = errorSchema(
  "NotFoundError",
  "NOT_FOUND",
  "No resource exists at the given id (or, for a nested path, at that combination of ids).",
);

export const ConflictErrorSchema = errorSchema(
  "ConflictError",
  "CONFLICT",
  "The request conflicts with the resource's current state — most commonly a duplicate " +
    "(unique field already in use) or an action that's already been taken (e.g. a payment " +
    "already confirmed, an enquiry already converted, a result already finalized).",
);

/// 402 is genuinely rare in this API — used ONLY for a result withheld
/// pending an outstanding fee balance (Feature D). Given its own bespoke
/// schema (not errorSchema()'s generic `details: unknown`) because
/// `outstandingKobo`/`feeObligationIds` are always present, not merely
/// possible — a client can build a "pay outstanding balance" CTA straight
/// from this response.
export const PaymentRequiredErrorSchema = z
  .object({
    error: z.object({
      code: z.literal("PAYMENT_REQUIRED"),
      message: z.string(),
      details: z.object({
        outstandingKobo: z.number().int(),
        feeObligationIds: z.array(z.string()),
      }),
    }),
  })
  .openapi("PaymentRequiredError", {
    description:
      "IMPORTANT — handle this status explicitly; an unhandled 402 renders as a generic error " +
      "and defeats the point of this response. The result exists and is FINALIZED, but is " +
      "withheld because the student has an outstanding fee balance for this term (or a " +
      "session-wide, not-term-specific fee) — partial payment does not release it. Distinct " +
      "from 404 (not published yet): a 404 here means check back later, a 402 means the parent " +
      "has an action to take now. `details.outstandingKobo` and `details.feeObligationIds` are " +
      "always present, so a client can render a \"pay outstanding balance\" call-to-action " +
      "directly from this response, without a follow-up request.",
  });
