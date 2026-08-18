import type { Express, Router } from "express";
import type { Role } from "../../generated/prisma/index.js";
import type { GuardType } from "./middleware.js";

export interface DiscoveredRoute {
  method: string;
  path: string;
  guardTypes: ReadonlySet<GuardType>;
  /// Union of every requireRole(...) allowlist found in this route's
  /// effective chain. Undefined if no role guard was found at all — distinct
  /// from an empty set, which can't actually occur (requireRole always takes
  /// at least one role in this codebase).
  allowedRoles: ReadonlySet<Role> | undefined;
}

export interface RouteMount {
  prefix: string;
  router: Router;
}

/// Express 5's Layer objects are not part of any public type — this is the
/// minimal shape this walker actually reads, verified against the real
/// installed express@5.2.1 at runtime (see the diagnostic scripts run while
/// building this), not assumed from Express 4 documentation.
interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
  handle?: unknown;
}

interface TaggedHandle {
  guardType: GuardType;
  roles?: readonly Role[];
}

function isTagged(fn: unknown): fn is TaggedHandle {
  return typeof fn === "function" && "guardType" in fn;
}

function hasStack(handle: unknown): handle is { stack: ExpressLayer[] } {
  return (
    typeof handle === "function" &&
    "stack" in handle &&
    Array.isArray((handle as { stack: unknown }).stack)
  );
}

function joinPath(prefix: string, routePath: string): string {
  if (routePath === "/") {
    return prefix;
  }
  return `${prefix}${routePath}`;
}

function collectRoles(handles: TaggedHandle[]): ReadonlySet<Role> | undefined {
  const roleHandles = handles.filter((h) => h.guardType === "role" && h.roles);
  if (roleHandles.length === 0) {
    return undefined;
  }
  const roles = new Set<Role>();
  for (const h of roleHandles) {
    for (const r of h.roles ?? []) {
      roles.add(r);
    }
  }
  return roles;
}

/// Walks one router's own layer stack in registration order, accumulating
/// "blanket" guard types from router.use(...) calls (which apply to every
/// route registered after them in the SAME router) and combining them with
/// each route's own per-route middleware chain.
function walkRouterStack(stack: ExpressLayer[], prefix: string, out: DiscoveredRoute[]): void {
  const blanketHandles: TaggedHandle[] = [];

  for (const layer of stack) {
    if (layer.route) {
      const effectiveHandles = [...blanketHandles];
      for (const entry of layer.route.stack) {
        if (isTagged(entry.handle)) {
          effectiveHandles.push(entry.handle);
        }
      }
      const guardTypes = new Set(effectiveHandles.map((h) => h.guardType));
      for (const method of Object.keys(layer.route.methods)) {
        out.push({
          method: method.toUpperCase(),
          path: joinPath(prefix, layer.route.path),
          guardTypes,
          allowedRoles: collectRoles(effectiveHandles),
        });
      }
      continue;
    }

    if (isTagged(layer.handle)) {
      blanketHandles.push(layer.handle);
    }
  }
}

/// Walks the live Express app's actual router stack at runtime and returns
/// every registered route with the set of guard types (auth/role/scope)
/// found in its effective middleware chain. `mounts` must be the exact same
/// array createApp() used to mount routers (app.ts's routeMounts export),
/// matched back to stack layers by reference — this is what lets the walker
/// recover each nested router's mount prefix, which Express 5's Layer
/// objects don't expose as a plain string.
export function buildRouteInventory(app: Express, mounts: RouteMount[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  const prefixByRouter = new Map<Router, string>(mounts.map((m) => [m.router, m.prefix]));

  const expressApp = app as unknown as { router: { stack: ExpressLayer[] } };
  for (const layer of expressApp.router.stack) {
    if (layer.route) {
      // Registered directly on the app, e.g. app.get("/health", ...) — path
      // is already complete, no prefix to add.
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({
          method: method.toUpperCase(),
          path: layer.route.path,
          guardTypes: new Set(),
          allowedRoles: undefined,
        });
      }
      continue;
    }

    const prefix = prefixByRouter.get(layer.handle as Router);
    if (prefix !== undefined && hasStack(layer.handle)) {
      walkRouterStack(layer.handle.stack, prefix, routes);
    }
  }

  return routes;
}
