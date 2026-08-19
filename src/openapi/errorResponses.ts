import type { DiscoveredRoute } from "../authorization/routeInventory.js";
import {
  ConflictErrorSchema,
  ForbiddenErrorSchema,
  NoRolesAssignedErrorSchema,
  NotFoundErrorSchema,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
} from "./errorSchemas.js";
import type { ResponseSpec } from "./routeSpecs.js";

/// Routes whose service layer can throw AppError.conflict(...) — built by
/// grepping every AppError.conflict( call site under src/modules and
/// mapping each one to the route(s) that reach it. Kept as an explicit
/// list rather than derived from anything on DiscoveredRoute/RouteSpec:
/// unlike method/path/roles, "can this route 409" isn't a runtime-visible
/// property of the route — there's no tag for it the way requireRole's
/// allowlist is tagged. Re-run the grep and update this list if a new
/// AppError.conflict( call site is added anywhere.
export const CONFLICT_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "POST /api/academic-sessions",
  "POST /api/academic-sessions/:id/terms",
  "POST /api/classes",
  "POST /api/subjects",
  "POST /api/class-subject-assignments",
  "POST /api/class-form-teachers",
  "POST /api/attendance-sessions",
  "POST /api/attendance-sessions/:id/close",
  "POST /api/academic-sessions/:id/assessment-components",
  "POST /api/academic-sessions/:id/grading-scale",
  "POST /api/grading-scales/:id/bands",
  "POST /api/parents",
  "POST /api/parents/:id/children",
  "POST /api/payments/:id/confirm",
  "POST /api/payments/:id/reject",
  "PUT /api/class-subject-assignments/:id/scores",
  "POST /api/students",
  "PATCH /api/students/:id",
  "POST /api/students/:id/enrollments",
  "POST /api/results/:id/finalize",
  "POST /api/users",
  "POST /api/admission-enquiries/:id/convert",
  "POST /api/staff",
  "PATCH /api/staff/:id",
  "POST /api/timetable-entries",
]);

/// login/refresh are PUBLIC (no requireRole in front to ever produce an
/// ordinary FORBIDDEN) — the one 403 either can throw is
/// buildAccessTokenPayload()'s zero-role check, which is NO_ROLES_ASSIGNED
/// specifically, not the generic ForbiddenError every guarded route gets.
const NO_ROLES_ASSIGNED_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/refresh",
]);

/// login/refresh are also the only PUBLIC routes (no requireAuth) whose own
/// business logic still 401s — on bad credentials or an invalid/expired/
/// already-used/reused refresh token — independent of the auth middleware
/// every other route's 401 comes from.
const PUBLIC_BUT_CAN_401_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "POST /api/auth/login",
  "POST /api/auth/refresh",
]);

function hasPathParam(path: string): boolean {
  return path.includes(":");
}

export interface RequestShape {
  requestBody?: unknown;
  requestParams?: unknown;
  requestQuery?: unknown;
}

/// The standard error responses a route gets, mechanically derived from
/// things already visible on the live route (allowedRoles, guardTypes),
/// its RouteSpec (does it validate a body/params/query), and the one
/// explicit list above that nothing else can derive automatically. Callers
/// merge this with the route's own declared success responses (see
/// generateSpec.ts) — success and error status codes never collide, so a
/// plain object merge is safe.
export function commonErrorResponses(
  route: DiscoveredRoute,
  routeKey: string,
  isPublic: boolean,
  request: RequestShape,
): Record<number, ResponseSpec> {
  const out: Record<number, ResponseSpec> = {};

  const hasRequestSchema =
    request.requestBody !== undefined || request.requestParams !== undefined || request.requestQuery !== undefined;
  if (hasRequestSchema) {
    out[400] = { description: "Validation failed", schema: ValidationErrorSchema };
  }

  if (!isPublic || PUBLIC_BUT_CAN_401_ROUTE_KEYS.has(routeKey)) {
    out[401] = { description: "Missing, invalid, or expired credentials", schema: UnauthorizedErrorSchema };
  }

  if (NO_ROLES_ASSIGNED_ROUTE_KEYS.has(routeKey)) {
    out[403] = {
      description: "The account authenticates but holds no roles at all",
      schema: NoRolesAssignedErrorSchema,
    };
  } else if (route.allowedRoles !== undefined || route.guardTypes.has("scope")) {
    out[403] = { description: "Not permitted to perform this action", schema: ForbiddenErrorSchema };
  }

  if (hasPathParam(route.path)) {
    out[404] = { description: "No resource exists at this id", schema: NotFoundErrorSchema };
  }

  if (CONFLICT_ROUTE_KEYS.has(routeKey)) {
    out[409] = { description: "Conflicts with the resource's current state", schema: ConflictErrorSchema };
  }

  return out;
}
