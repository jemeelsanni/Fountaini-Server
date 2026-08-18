import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors/AppError.js";
import { requireRole } from "./middleware.js";
import type { Principal } from "./types.js";

function fakeReq(principal: Principal): Request {
  return { principal } as unknown as Request;
}

function fakeNext(): ((err?: unknown) => void) & { calls: unknown[] } {
  const calls: unknown[] = [];
  const fn = (err?: unknown) => {
    calls.push(err);
  };
  return Object.assign(fn, { calls });
}

/// requireRole passes on a non-empty intersection between the route's
/// allowed roles and the caller's roles — not on the caller's "primary" role
/// or on set equality. A caller who holds a role the route doesn't care
/// about (TEACHER, here) alongside one it does (BURSAR) must still get
/// through: this is the exact shape of a staff-parent hitting a route scoped
/// to a role that isn't part of their parent/teacher split.
describe("requireRole", () => {
  it("allows a multi-role caller whose roles intersect the allowlist on a non-first role", () => {
    const guard = requireRole("ADMIN", "BURSAR");
    const req = fakeReq({
      userId: "u1",
      roles: new Set(["TEACHER", "BURSAR"]),
      staffId: "s1",
      parentId: null,
      studentId: null,
    });
    const next = fakeNext();

    guard(req, {} as Response, next);

    expect(next.calls).toEqual([undefined]);
  });

  it("rejects a multi-role caller with no overlap with the allowlist", () => {
    const guard = requireRole("ADMIN", "BURSAR");
    const req = fakeReq({
      userId: "u1",
      roles: new Set(["TEACHER", "PARENT"]),
      staffId: "s1",
      parentId: "p1",
      studentId: null,
    });
    const next = fakeNext();

    guard(req, {} as Response, next);

    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]).toBeInstanceOf(AppError);
    expect((next.calls[0] as AppError).statusCode).toBe(403);
  });
});
