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
  // Unblocks a withheld report card despite an outstanding balance —
  // ADMIN-only for the same reason overriding a finalized field is.
  "POST /api/results/:id/release-withholding": ["ADMIN"],

  // --- Ratings: affective/psychomotor entry ---
  // requireRole tags ADMIN+TEACHER; requireScope narrows TEACHER further to
  // only the form teacher of this specific class (canWriteClassRatings).
  "PUT /api/classes/:id/results/:termId/ratings": ["ADMIN", "TEACHER"],

  // --- Users: create / activate / deactivate (account lifecycle) ---
  "POST /api/users": ["ADMIN"],
  "POST /api/users/:id/activate": ["ADMIN"],
  "POST /api/users/:id/deactivate": ["ADMIN"],
  // Generates a fresh password and revokes existing sessions for an
  // already-issued student login — ADMIN-only for the same account-
  // lifecycle reason as the three above.
  "POST /api/students/:id/reissue-credentials": ["ADMIN"],
  // Bulk lifecycle: up to 500 students at once, and GRADUATED/WITHDRAWN
  // also close each one's active enrollment(s) — same blast-radius class
  // as the account-lifecycle rows above, just batched.
  "PATCH /api/students/status": ["ADMIN"],
  // Moves a student's current-session enrollment between classes —
  // same account/enrollment-lifecycle blast radius as the rows above.
  "POST /api/students/:id/transfer": ["ADMIN"],

  // --- Notifications: mass fee-reminder trigger ---
  "POST /api/notifications/fee-reminders/trigger": ["ADMIN", "BURSAR"],

  // --- Payments: confirm ---
  "POST /api/payments/:id/confirm": ["ADMIN", "BURSAR"],

  // --- Fee structures / obligations: mutations ---
  "PATCH /api/fee-structures/:id": ["ADMIN", "BURSAR"],
  "DELETE /api/fee-structures/:id": ["ADMIN", "BURSAR"],
  "PATCH /api/fee-obligations/:id": ["ADMIN", "BURSAR"],
  // REMOVED deliberately, not dropped by accident: this route no longer
  // has a bare requireRole at all — it's scope-only now (requireScope ->
  // canCreatePaymentForObligation: ADMIN/BURSAR always, or a PARENT linked
  // to the obligation's own student), so its live allowedRoles is
  // undefined and this snapshot's flat role-list model can't represent it
  // anyway ("PARENT" here would wrongly read as "any parent," not "a
  // linked one"). Every other scope-only financial route (GET
  // /api/fee-obligations/:id, GET /api/payments/:id/receipt, etc.) is
  // absent from this file for the same reason and is pinned by
  // authMatrix.data.ts's bespoke rows instead — this route now follows
  // that same, more accurate mechanism. POST .../confirm above is
  // unchanged: still requireRole("ADMIN","BURSAR") only, never scoped to a
  // parent.

  // --- Academic session / term: mutations ---
  "POST /api/academic-sessions": ["ADMIN"],
  "PATCH /api/academic-sessions/:id/set-current": ["ADMIN"],
  "POST /api/academic-sessions/:id/terms": ["ADMIN"],
  "PATCH /api/terms/:id/set-current": ["ADMIN"],

  // --- Grading configuration: shared across every student in a session ---
  // Same shape as the fee-structure rows above — a shared configuration
  // entity with many dependent records (Score, SubjectResult) — pinned for
  // the same reason.
  "PATCH /api/assessment-components/:id": ["ADMIN"],
  "DELETE /api/assessment-components/:id": ["ADMIN"],
  "PATCH /api/grade-bands/:id": ["ADMIN"],
  "DELETE /api/grade-bands/:id": ["ADMIN"],

  // --- Parent privacy: family structure ---
  // Not a mutation, but pinned like one anyway: this route enumerates a
  // family's children from a parent id — TEACHER must never be widened onto
  // it (see canReadParent's own comment for why). Representable here only
  // because canReadParent's eligible set is a hard, narrow allowlist —
  // requireRole("ADMIN", "PARENT") sits in front of the requireScope check
  // specifically so this file's role-set comparison (which reads
  // route.allowedRoles, populated only by requireRole) has something real
  // to compare against.
  //
  // GET /api/students/:id/results (the other new route from this pass) is
  // deliberately NOT here: it's gated by canReadStudent alone, the same as
  // six existing sibling routes (GET /api/students/:id,
  // /:id/attendance, /:id/scores, /:id/madrassah-progress, /:id/enrollments,
  // and GET /api/results/:studentId/:termId) — none of which are in this
  // file, because none of them carry a requireRole tag this file's
  // allowedRoles comparison could check against. Adding a requireRole
  // wrapper to only the new route to force it in here would make it
  // inconsistent with every sibling that shares its exact authorization
  // shape, for a check this file was never built to express for this
  // family of routes. It's still fully covered elsewhere: routeGuards.test.ts
  // (has-a-guard) and the auth matrix's STUDENT_SCOPE_CASES (the precise
  // per-actor allow/deny table).
  "GET /api/parents/:id/children": ["ADMIN", "PARENT"],
};
