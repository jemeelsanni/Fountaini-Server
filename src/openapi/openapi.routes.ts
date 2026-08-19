import type { Express, Request } from "express";
import swaggerUi from "swagger-ui-express";
import type { RouteMount } from "../authorization/routeInventory.js";
import { generateOpenApiDocument } from "./generateSpec.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- required syntax for augmenting Express's ambient Request type
  namespace Express {
    interface Request {
      /// swagger-ui-express's own per-request override hook (checked inside
      /// both its init-JS handler and its HTML handler) — set here instead
      /// of relying on the doc baked in at construction time, since these
      /// routes are registered before every other router (see app.ts) and
      /// so would otherwise see an empty route inventory.
      swaggerDoc?: unknown;
    }
  }
}

/// Registers GET /api/openapi.json and GET /api/docs directly on `app`
/// (mirroring how /health is registered directly, not through a router) —
/// deliberately NOT a sub-router mounted at "/api": buildRouteInventory()
/// only descends into a router if it's listed in the `mounts` array it's
/// given, which would make /api/openapi.json's own discoverability depend
/// on circularly including this router in that array. Direct app.get()
/// registration is unconditionally discovered by buildRouteInventory()'s
/// own top-level walk instead, the same path /health already takes.
///
/// Both routes are public (see PUBLIC_ROUTES) — API documentation needs no
/// access token to read. Registered before every routeMounts router in
/// app.ts for the same reason admissionsRouter is first among those: a
/// blanket, path-less requireAuth further down the chain would otherwise
/// intercept these before Express ever checks whether it actually owns the
/// path.
export function mountOpenApiRoutes(app: Express, mounts: RouteMount[]): void {
  app.get("/api/openapi.json", (_req, res) => {
    res.status(200).json(generateOpenApiDocument(app, mounts));
  });

  app.use("/api/docs", (req: Request, _res, next) => {
    req.swaggerDoc = generateOpenApiDocument(app, mounts);
    next();
  });
  app.use("/api/docs", swaggerUi.serveFiles(), swaggerUi.setup());
}
