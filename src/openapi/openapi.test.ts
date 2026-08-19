import { describe, expect, it } from "vitest";
import { createApp, routeMounts } from "../app.js";
import { buildRouteInventory, type DiscoveredRoute } from "../authorization/routeInventory.js";
import { findUndocumentedRoutes, generateOpenApiDocument } from "./generateSpec.js";

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
