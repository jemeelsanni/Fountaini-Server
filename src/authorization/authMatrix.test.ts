import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createApp, routeMounts } from "../app.js";
import { resetDb } from "../test/resetDb.js";
import {
  BESPOKE_ROUTE_KEYS,
  buildAutoRows,
  buildBespokeRows,
  createGenericActors,
  type ExpectedStatus,
  type MatrixRow,
} from "./authMatrix.data.js";
import { buildRouteInventory } from "./routeInventory.js";

const app = createApp();

// Runs during this file's own sequential slot (vitest.config.ts pins the
// whole suite to one worker/one fork specifically so no other file's
// resetDb() can land mid-file) — building every fixture once, up front, so
// describe.each below has concrete rows at collection time.
await resetDb();
const generics = await createGenericActors();
const inventory = buildRouteInventory(app, routeMounts);
const autoRows = buildAutoRows(inventory, generics);
const bespokeRows = await buildBespokeRows(generics);
const rows: MatrixRow[] = [...autoRows, ...bespokeRows];

afterAll(async () => {
  await resetDb();
});

describe("auth matrix bookkeeping", () => {
  it("built exactly the bespoke rows BESPOKE_ROUTE_KEYS promises the route-guard inventory test", () => {
    expect(bespokeRows.map((r) => r.name).sort()).toEqual([...BESPOKE_ROUTE_KEYS].sort());
  });

  it("built a plausible number of auto-generated rows (sanity check on the filter itself)", () => {
    expect(autoRows.length).toBeGreaterThan(50);
  });
});

function isRejection(status: ExpectedStatus): boolean {
  return status === 401 || status === 403;
}

describe.each(rows.map((row) => ({ row, key: row.name })))("$key", ({ row }) => {
  it("matches the expected status for every actor in this row's matrix", async () => {
    const { url, body, tokens } = await row.setup();

    // Rejections (401/403) first, any "allowed" case last — allowed cases
    // may mutate state (a real PUT/POST reaching the controller), and must
    // never run before a check that assumes pre-mutation state.
    const orderedCases = [...row.cases].sort(
      (a, b) => Number(isRejection(b.expectedStatus)) - Number(isRejection(a.expectedStatus)),
    );

    for (const c of orderedCases) {
      const token = tokens[c.actor];
      let req = request(app)[row.method](url);
      if (token) {
        req = req.set("Authorization", `Bearer ${token}`);
      }
      if (body !== undefined) {
        req = req.send(body as Record<string, unknown>);
      }
      const res = await req;

      if (c.expectedStatus === "allowed") {
        expect(
          [401, 403].includes(res.status),
          `${row.name} as ${c.actor} was blocked by the authorization layer (${res.status}): ${JSON.stringify(res.body)}`,
        ).toBe(false);
      } else {
        expect(
          res.status,
          `${row.name} as ${c.actor} expected ${c.expectedStatus}, got ${res.status}: ${JSON.stringify(res.body)}`,
        ).toBe(c.expectedStatus);
      }
    }
  });
});
