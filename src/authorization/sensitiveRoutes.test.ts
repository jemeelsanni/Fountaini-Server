import type { Role } from "../../generated/prisma/index.js";
import { describe, expect, it } from "vitest";
import { createApp, routeMounts } from "../app.js";
import { buildRouteInventory, type DiscoveredRoute } from "./routeInventory.js";
import { SENSITIVE_ROUTE_ROLES } from "./sensitiveRoutes.snapshot.js";

function routeKey(route: DiscoveredRoute): string {
  return `${route.method} ${route.path}`;
}

function sortedRoles(roles: Iterable<Role>): Role[] {
  return [...roles].sort();
}

const app = createApp();
const inventory = buildRouteInventory(app, routeMounts);
const byKey = new Map(inventory.map((route) => [routeKey(route), route]));

describe("sensitive-route role snapshot", () => {
  describe.each(Object.entries(SENSITIVE_ROUTE_ROLES).map(([key, roles]) => ({ key, roles })))(
    "$key",
    ({ key, roles }) => {
      it("has exactly the snapshotted allowed-role set", () => {
        const route = byKey.get(key);
        expect(
          route,
          `${key} is snapshotted in sensitiveRoutes.snapshot.ts but no longer exists in the app. ` +
            `Update or remove its entry.`,
        ).toBeDefined();

        const liveRoles = sortedRoles(route?.allowedRoles ?? []);
        const snapshotRoles = sortedRoles(roles);

        expect(
          liveRoles,
          `${key}'s live allowed-role set is [${liveRoles.join(", ")}], but the snapshot says ` +
            `[${snapshotRoles.join(", ")}]. If this change is intentional, update ` +
            `sensitiveRoutes.snapshot.ts in the same commit.`,
        ).toEqual(snapshotRoles);
      });
    },
  );
});
