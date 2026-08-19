import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import type { RouteParameter } from "@asteasolutions/zod-to-openapi/dist/openapi-registry.js";
import { z, type ZodTypeAny } from "zod";
import type { Express } from "express";
import { env } from "../config/env.js";
import { buildRouteInventory, type DiscoveredRoute, type RouteMount } from "../authorization/routeInventory.js";
import { PUBLIC_ROUTES } from "../authorization/publicRoutes.js";
import "./zodSetup.js";
import { commonErrorResponses } from "./errorResponses.js";
import { registry } from "./registry.js";
import { ROUTE_SPECS, type ResponseSpec, type RouteSpec } from "./routeSpecs.js";

const HealthResponseSchema = z.object({ status: z.literal("ok") }).openapi("Health");
const HealthUnavailableSchema = z.object({ status: z.literal("unavailable") }).openapi("HealthUnavailable");

/// Routes outside src/modules — /health (registered directly on `app`) and
/// this generator's own /api/openapi.json (registered by
/// openapi.routes.ts, not through validate()/a module *.schemas.ts file
/// like everything in ROUTE_SPECS) — both still show up in
/// buildRouteInventory() like any other route, so both need an entry here
/// or openapi.test.ts's coverage check fails on them. /api/docs itself
/// does NOT need one: it's mounted via router.use(), which never creates
/// an Express Route object, so the inventory walker (which only looks at
/// layer.route) never sees it at all.
const SPECIAL_ROUTE_SPECS: Record<string, RouteSpec> = {
  "GET /health": {
    summary: "Liveness check — does a trivial DB round-trip (SELECT 1), Railway's healthcheck target",
    responses: {
      200: { description: "OK", schema: HealthResponseSchema },
      503: { description: "Database round-trip failed", schema: HealthUnavailableSchema },
    },
  },
  "GET /api/openapi.json": {
    summary: "This OpenAPI 3.1 document",
    responses: { 200: { description: "OK" } },
  },
};

function expressPathToOpenApi(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

function jsonContent(schema: ZodTypeAny) {
  return { content: { "application/json": { schema } } };
}

function buildResponses(responses: Record<number, ResponseSpec>) {
  const out: Record<string, { description: string; content?: ReturnType<typeof jsonContent>["content"] }> = {};
  for (const [status, spec] of Object.entries(responses)) {
    out[status] = spec.schema
      ? { description: spec.description, ...jsonContent(spec.schema) }
      : { description: spec.description };
  }
  return out;
}

function routeKey(route: DiscoveredRoute): string {
  return `${route.method} ${route.path}`;
}

/// Every route this generator could not find a ROUTE_SPECS (or the
/// hardcoded /health) entry for — openapi.test.ts asserts this is empty on
/// the real, live route inventory. Exported so the test can report exactly
/// which routes are missing rather than just "coverage failed".
export function findUndocumentedRoutes(inventory: DiscoveredRoute[]): string[] {
  return inventory
    .map(routeKey)
    .filter((key) => !(key in SPECIAL_ROUTE_SPECS) && !(key in ROUTE_SPECS));
}

function registerRoute(route: DiscoveredRoute, spec: RouteSpec): void {
  const key = routeKey(route);
  const isPublic = PUBLIC_ROUTES.has(key);
  const request: {
    body?: ReturnType<typeof jsonContent>;
    params?: RouteParameter;
    query?: RouteParameter;
  } = {};
  if (spec.requestBody) {
    request.body = jsonContent(spec.requestBody);
  }
  if (spec.requestParams) {
    request.params = spec.requestParams;
  }
  if (spec.requestQuery) {
    request.query = spec.requestQuery;
  }

  // Error responses are mechanically derived (see errorResponses.ts) —
  // spec.responses (the route's own declared success responses) is spread
  // last so an explicit entry there would win on any status-code collision,
  // though none exists today: the derived set only ever produces
  // 400/401/403/404/409, never a 2xx.
  const responses = {
    ...buildResponses(commonErrorResponses(route, key, isPublic, spec)),
    ...buildResponses(spec.responses),
  };

  registry.registerPath({
    method: route.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete",
    path: expressPathToOpenApi(route.path),
    summary: spec.summary,
    // route.allowedRoles is the exact same field the auth matrix reads
    // (src/authorization/authMatrix.data.ts) — sourced live from the
    // running app's requireRole(...) tags, not hand-duplicated here.
    ...(route.allowedRoles ? { "x-roles": [...route.allowedRoles].sort() } : {}),
    ...(isPublic ? {} : { security: [{ bearerAuth: [] }] }),
    request,
    responses,
  });
}

/// Builds the full OpenAPI 3.1 document from the live route inventory (for
/// method/path/roles — the same source the auth matrix reads) plus the
/// hand-written per-route request/response schemas in routeSpecs.ts (built
/// from this codebase's existing Zod validation schemas, and new response
/// schemas for shapes that had no prior Zod counterpart — see
/// resourceSchemas.ts).
export function generateOpenApiDocument(app: Express, mounts: RouteMount[]) {
  const inventory = buildRouteInventory(app, mounts);

  for (const route of inventory) {
    const key = routeKey(route);
    const spec = SPECIAL_ROUTE_SPECS[key] ?? ROUTE_SPECS[key];
    if (!spec) {
      // Caught by openapi.test.ts before this would ever run against a real
      // deploy — registerPath is skipped rather than thrown here so a
      // partial spec can still be generated for local debugging.
      continue;
    }
    registerRoute(route, spec);
  }

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "School Management Portal API",
      version: "0.1.0",
      description:
        "Every route below is generated from this codebase's own Zod validation schemas and its live " +
        "role-guard tags (the same source src/authorization/authMatrix.data.ts reads) — see " +
        "src/openapi/. `x-roles` on an operation lists the roles allowed through its role gate; an " +
        "operation with no `security` requirement is public.",
    },
    servers: [{ url: env.PUBLIC_BASE_URL }],
  });
}
