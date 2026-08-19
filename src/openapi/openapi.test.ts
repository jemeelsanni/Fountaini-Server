import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, routeMounts } from "../app.js";
import { buildRouteInventory, type DiscoveredRoute } from "../authorization/routeInventory.js";
import { CONFLICT_ROUTE_KEYS } from "./errorResponses.js";
import { findUndocumentedRoutes, generateOpenApiDocument } from "./generateSpec.js";
import { mountOpenApiRoutes } from "./openapi.routes.js";
import { findConflictRoutes } from "./scanConflictRoutes.js";

const app = createApp();
const inventory = buildRouteInventory(app, routeMounts);

function routeKey(route: DiscoveredRoute): string {
  return `${route.method} ${route.path}`;
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
}

describe("OpenAPI spec coverage", () => {
  it("has a routeSpecs entry for every route in the route inventory", () => {
    // Same failure shape as routeGuards.test.ts's "every non-public route
    // has an auth-matrix row" check: a route with a guard but no docs entry
    // fails the build the same way an unguarded one does, rather than
    // silently shipping an incomplete spec.
    expect(
      findUndocumentedRoutes(inventory),
      "These routes have no OpenAPI documentation. Add an entry to src/openapi/routeSpecs.ts " +
        "(or, for a route outside src/modules, to generateSpec.ts's SPECIAL_ROUTE_SPECS).",
    ).toEqual([]);
  });

  it("actually registers every inventory route as a path+method in the generated document", () => {
    // Stronger than the check above: routeSpecs.ts having an entry doesn't
    // by itself prove generateOpenApiDocument() successfully turned it into
    // a real operation in the output (a typo'd path/method combination in
    // routeSpecs.ts would pass the first check while silently registering
    // nothing, or registering the wrong path, here).
    const doc = generateOpenApiDocument(app, routeMounts);
    const missing: string[] = [];

    for (const route of inventory) {
      const openApiPath = toOpenApiPath(route.path);
      const pathItem = doc.paths?.[openApiPath] as Record<string, unknown> | undefined;
      const operation = pathItem?.[route.method.toLowerCase()];
      if (!operation) {
        missing.push(routeKey(route));
      }
    }

    expect(missing, "These routes are undocumented in the generated OpenAPI document itself").toEqual([]);
  });

  it("tags every guarded route's operation with the same allowedRoles the auth matrix reads", () => {
    const doc = generateOpenApiDocument(app, routeMounts);

    for (const route of inventory) {
      if (!route.allowedRoles) {
        continue;
      }
      const openApiPath = toOpenApiPath(route.path);
      const pathItem = doc.paths?.[openApiPath] as Record<string, Record<string, unknown>> | undefined;
      const operation = pathItem?.[route.method.toLowerCase()];
      const xRoles = operation?.["x-roles"] as string[] | undefined;

      expect(xRoles, `${routeKey(route)} is role-guarded but has no x-roles in the generated spec`).toBeDefined();
      expect(new Set(xRoles), routeKey(route)).toEqual(new Set(route.allowedRoles));
    }
  });

  it("marks every route in PUBLIC_ROUTES as having no security requirement, and every other route as having one", async () => {
    const { PUBLIC_ROUTES } = await import("../authorization/publicRoutes.js");
    const doc = generateOpenApiDocument(app, routeMounts);

    for (const route of inventory) {
      const openApiPath = toOpenApiPath(route.path);
      const pathItem = doc.paths?.[openApiPath] as Record<string, Record<string, unknown>> | undefined;
      const operation = pathItem?.[route.method.toLowerCase()];
      const isPublic = PUBLIC_ROUTES.has(routeKey(route));

      if (isPublic) {
        expect(operation?.security, routeKey(route)).toBeUndefined();
      } else {
        expect(operation?.security, routeKey(route)).toBeDefined();
      }
    }
  });

  it("generates a spec whose servers block is the configured PUBLIC_BASE_URL, not this machine's own address", async () => {
    const { env } = await import("../config/env.js");
    const doc = generateOpenApiDocument(app, routeMounts);
    expect(doc.servers).toEqual([{ url: env.PUBLIC_BASE_URL }]);
  });
});

interface OperationLike {
  responses?: Record<string, { content?: { "application/json"?: { schema?: { $ref?: string } } } }>;
}

function responseRef(doc: ReturnType<typeof generateOpenApiDocument>, path: string, method: string, status: number) {
  const pathItem = doc.paths?.[path] as Record<string, OperationLike> | undefined;
  return pathItem?.[method]?.responses?.[status]?.content?.["application/json"]?.schema?.$ref;
}

describe("OpenAPI error response documentation", () => {
  const doc = generateOpenApiDocument(app, routeMounts);

  it("every $ref in every error response resolves to a real registered component", () => {
    const schemaNames = new Set(Object.keys(doc.components?.schemas ?? {}));
    const dangling: string[] = [];

    for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem as Record<string, OperationLike>)) {
        for (const [status, response] of Object.entries(operation.responses ?? {})) {
          if (Number(status) < 400) continue;
          const ref = response.content?.["application/json"]?.schema?.$ref;
          if (ref && !schemaNames.has(ref.replace("#/components/schemas/", ""))) {
            dangling.push(`${method.toUpperCase()} ${path} -> ${status} -> ${ref}`);
          }
        }
      }
    }

    expect(dangling).toEqual([]);
  });

  it("gives login/refresh a NO_ROLES_ASSIGNED 403, not the ordinary ForbiddenError every guarded route gets", () => {
    expect(responseRef(doc, "/api/auth/login", "post", 403)).toBe("#/components/schemas/NoRolesAssignedError");
    expect(responseRef(doc, "/api/auth/refresh", "post", 403)).toBe("#/components/schemas/NoRolesAssignedError");
    // And they still don't get the generic role-gate ForbiddenError — they
    // have no requireRole in front of them at all to produce one.
    expect(responseRef(doc, "/api/auth/login", "post", 403)).not.toBe("#/components/schemas/ForbiddenError");
  });

  it("documents 401 on login/refresh even though they're public routes with no requireAuth", () => {
    expect(responseRef(doc, "/api/auth/login", "post", 401)).toBe("#/components/schemas/UnauthorizedError");
    expect(responseRef(doc, "/api/auth/refresh", "post", 401)).toBe("#/components/schemas/UnauthorizedError");
  });

  it("documents 409 CONFLICT on exactly the routes whose service layer can throw it, and nowhere else", () => {
    for (const route of inventory) {
      const key = routeKey(route);
      const openApiPath = toOpenApiPath(route.path);
      const ref = responseRef(doc, openApiPath, route.method.toLowerCase(), 409);

      if (CONFLICT_ROUTE_KEYS.has(key)) {
        expect(ref, key).toBe("#/components/schemas/ConflictError");
      } else {
        expect(ref, key).toBeUndefined();
      }
    }
  });

  it("keeps CONFLICT_ROUTE_KEYS in sync with the real source — scans every AppError.conflict( call site under src/modules, resolves each to its route via the live app (not text-guessing), and requires an exact match", () => {
    // CONFLICT_ROUTE_KEYS itself is hand-maintained (see its own comment —
    // "can this route 409" isn't a runtime-visible tag the way allowedRoles
    // is). This is the check that keeps it honest: unlike the test above,
    // which only proves the generated *spec* matches whatever
    // CONFLICT_ROUTE_KEYS currently says, this one independently rederives
    // the answer from the actual service/controller source files and the
    // live route tree, so a new AppError.conflict( call — or an existing
    // one newly wired up to a different route — fails here even if nobody
    // remembers to update CONFLICT_ROUTE_KEYS by hand. Same failure shape
    // as an unguarded route: caught by CI, not discovered later.
    const scanned = findConflictRoutes(app, routeMounts);

    const undocumented = [...scanned].filter((key) => !CONFLICT_ROUTE_KEYS.has(key));
    const stale = [...CONFLICT_ROUTE_KEYS].filter((key) => !scanned.has(key));

    expect(
      undocumented,
      "These routes reach an AppError.conflict( call per the real source, but aren't in " +
        "CONFLICT_ROUTE_KEYS (src/openapi/errorResponses.ts) — add them.",
    ).toEqual([]);
    expect(
      stale,
      "These routes are in CONFLICT_ROUTE_KEYS but the scanner found no AppError.conflict( " +
        "call reaching them anymore — remove them, or check why the scan missed them.",
    ).toEqual([]);
  });

  it("gives a route with no request schema, no path param, and no guard no 400/401/403/404/409 at all", () => {
    const pathItem = doc.paths?.["/health"] as Record<string, OperationLike> | undefined;
    const responses = pathItem?.get?.responses ?? {};
    for (const status of [400, 401, 403, 404, 409]) {
      expect(responses[status], `/health ${status}`).toBeUndefined();
    }
  });
});

describe("DOCS_ENABLED gating", () => {
  it("mounts nothing at all when disabled — a request just falls through to the normal 404 handler", async () => {
    const miniApp = express();
    mountOpenApiRoutes(miniApp, [], false);
    miniApp.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Not Found" } }));

    const jsonRes = await request(miniApp).get("/api/openapi.json");
    const docsRes = await request(miniApp).get("/api/docs");
    expect(jsonRes.status).toBe(404);
    expect(docsRes.status).toBe(404);
  });

  it("mounts both routes when enabled", async () => {
    const miniApp = express();
    mountOpenApiRoutes(miniApp, [], true);

    const jsonRes = await request(miniApp).get("/api/openapi.json");
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.body.openapi).toBe("3.1.0");
  });

  it("keeps the route-coverage check independent of the flag — it calls generateOpenApiDocument() directly, never through the mounted HTTP routes above", () => {
    // Not a new assertion so much as documentation-by-test: every test in
    // the "OpenAPI spec coverage" describe block above already builds its
    // document via generateOpenApiDocument(app, routeMounts) directly, and
    // none of them call mountOpenApiRoutes or touch DOCS_ENABLED — so
    // coverage is verified whether or not the docs routes are actually
    // reachable in this environment.
    expect(findUndocumentedRoutes(inventory)).toEqual([]);
  });
});
