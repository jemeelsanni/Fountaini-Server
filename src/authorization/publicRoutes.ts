/// Genuinely public routes — no access token possible or required. Shared by
/// the route-guard inventory test (what's exempt from "must have an explicit
/// guard") and the auth matrix (what's skipped by auto-generated role rows).
/// One list, so the two can never quietly disagree about what's public.
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /health",
  "POST /api/auth/login",
  // refresh/logout authenticate via the refresh token in the request body,
  // not an access token — requireAuth doesn't apply to them either.
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "POST /api/admission-enquiries",
  // /api/docs itself is exempt from needing an entry here at all — it's
  // mounted via router.use(), which the route-guard inventory walker never
  // sees (only router.get/post/etc. produce a discoverable Route). Only
  // this one, a real registered GET route, needs to be listed.
  "GET /api/openapi.json",
]);
