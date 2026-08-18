import type { Role } from "../../generated/prisma/index.js";

/// Hand-written, literal snapshot of the EXACT allowed-role set for routes
/// whose blast radius (irreversible academic/financial actions, account
/// lifecycle, mass notifications) justifies more than "has some guard"
/// (routeGuards.test.ts) or "is covered by the auth matrix"
/// (authMatrix.data.ts) — it pins the precise set of roles, so widening any
/// one of these (e.g. adding TEACHER to results/override, or BURSAR to
/// users/deactivate) requires editing this file in the same commit.
/// sensitiveRoutes.test.ts fails otherwise: a widened role set then shows up
/// in review as a line changed here, not as a silent side effect of an
/// unrelated routes.ts edit.
///
/// Deliberately NOT auto-derived from the live route table — the whole point
/// is a value a human wrote down on purpose, that a human must edit on
/// purpose.
export const SENSITIVE_ROUTE_ROLES: Readonly<Record<string, readonly Role[]>> = {
  // --- Results: compute / finalize / override ---
  "POST /api/results/compute": ["ADMIN"],
  "POST /api/results/:id/finalize": ["ADMIN"],
  "POST /api/results/:id/override": ["ADMIN"],

  // --- Users: create / activate / deactivate (account lifecycle) ---
  "POST /api/users": ["ADMIN"],
  "POST /api/users/:id/activate": ["ADMIN"],
  "POST /api/users/:id/deactivate": ["ADMIN"],

  // --- Notifications: mass fee-reminder trigger ---
  "POST /api/notifications/fee-reminders/trigger": ["ADMIN", "BURSAR"],

  // --- Payments: confirm ---
  "POST /api/payments/:id/confirm": ["ADMIN", "BURSAR"],

  // --- Fee obligations: mutations (routes rooted at /fee-obligations/:id) ---
  "PATCH /api/fee-obligations/:id": ["ADMIN", "BURSAR"],
  "POST /api/fee-obligations/:id/payments": ["ADMIN", "BURSAR"],

  // --- Academic session / term: mutations ---
  "POST /api/academic-sessions": ["ADMIN"],
  "PATCH /api/academic-sessions/:id/set-current": ["ADMIN"],
  "POST /api/academic-sessions/:id/terms": ["ADMIN"],
  "PATCH /api/terms/:id/set-current": ["ADMIN"],
};
