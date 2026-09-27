import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Principal } from "../../authorization/types.js";
import { prisma } from "../../db/client.js";
import { drainFireAndForget } from "../../lib/fireAndForget.js";
import { createAdmin } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";
import { auditMutation } from "./auditMutation.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

/// A small, isolated harness — same spirit as rateLimit.test.ts's own: a
/// real Express app + supertest exercising the real middleware, rather than
/// hand-mocking Request/Response, with a trivial PATCH handler standing in
/// for any real route's controller.
function buildApp(principal: Principal, mw: ReturnType<typeof auditMutation>) {
  const app = express();
  app.use((req, _res, next) => {
    req.principal = principal;
    next();
  });
  app.patch("/widgets/:id", mw, (req, res) => {
    res.status(200).json({ id: req.params.id, updated: true });
  });
  return app;
}

async function buildAdminPrincipal(): Promise<Principal> {
  const { user } = await createAdmin("admin@test.local");
  return { userId: user.id, roles: new Set(["ADMIN"]), staffId: null, parentId: null, studentId: null };
}

describe("auditMutation's fetchBefore", () => {
  it("captures a real beforeData snapshot when fetchBefore succeeds", async () => {
    const principal = await buildAdminPrincipal();
    const mw = auditMutation("Widget", "WIDGET_UPDATED", {
      fetchBefore: (id) => Promise.resolve({ id, name: "old-name" }),
    });
    const app = buildApp(principal, mw);

    const res = await request(app).patch("/widgets/widget-1");
    expect(res.status).toBe(200);

    await drainFireAndForget();
    const entry = await prisma.auditLog.findFirst({ where: { entityType: "Widget", entityId: "widget-1" } });
    expect(entry).not.toBeNull();
    expect((entry?.beforeData as { name: string } | null)?.name).toBe("old-name");
    expect((entry?.afterData as { updated: boolean } | null)?.updated).toBe(true);
  });

  // The core resilience requirement: an audit READ is not allowed to turn
  // an otherwise-successful request into a failure — mirrors the same
  // posture this codebase already takes for the audit WRITE (fire-and-
  // forget: a slow/failing write never delays or breaks the request).
  it("does not fail the mutation when fetchBefore throws — writes the row with beforeData: null instead", async () => {
    const principal = await buildAdminPrincipal();
    const mw = auditMutation("Widget", "WIDGET_UPDATED", {
      fetchBefore: () => Promise.reject(new Error("simulated fetchBefore failure")),
    });
    const app = buildApp(principal, mw);

    const res = await request(app).patch("/widgets/widget-2");
    expect(res.status, "the mutation itself must still succeed").toBe(200);
    expect(res.body).toEqual({ id: "widget-2", updated: true });

    await drainFireAndForget();
    const entry = await prisma.auditLog.findFirst({ where: { entityType: "Widget", entityId: "widget-2" } });
    expect(entry, "the mutation must still be audited even though fetchBefore failed").not.toBeNull();
    expect(entry?.beforeData).toBeNull();
    expect((entry?.afterData as { updated: boolean } | null)?.updated).toBe(true);
  });

  it("never calls fetchBefore, and beforeData stays null, for a route with no fetchBefore option", async () => {
    const principal = await buildAdminPrincipal();
    const mw = auditMutation("Widget", "WIDGET_UPDATED");
    const app = buildApp(principal, mw);

    const res = await request(app).patch("/widgets/widget-3");
    expect(res.status).toBe(200);

    await drainFireAndForget();
    const entry = await prisma.auditLog.findFirst({ where: { entityType: "Widget", entityId: "widget-3" } });
    expect(entry?.beforeData).toBeNull();
  });
});
