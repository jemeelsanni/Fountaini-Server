import express from "express";
import { rateLimit } from "express-rate-limit";
import request from "supertest";
import { describe, expect, it } from "vitest";

/// A small, isolated harness — not the real authRateLimiter/etc. exports
/// from rateLimit.ts, which are unenforced under NODE_ENV=test (see that
/// file's own comment: the functional suite legitimately calls
/// POST /api/auth/login far more than 10 times per file, which has nothing
/// to do with whether rate-limiting itself works). This builds a fresh
/// limiter directly, the same way app.ts wires trust proxy + a limiter
/// together, so it exercises real enforcement regardless of NODE_ENV.
function buildLimitedApp(limit: number) {
  const app = express();
  // Same setting app.ts applies for the real app (see its own comment) —
  // without it, Express ignores X-Forwarded-For entirely and req.ip is
  // always the direct TCP peer address, which is what this test exists to
  // prove matters.
  app.set("trust proxy", 1);
  app.use("/limited", rateLimit({ windowMs: 60_000, limit, standardHeaders: true, legacyHeaders: false }));
  app.get("/limited", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("rate limiting reads the real client IP through the proxy", () => {
  it("buckets two different X-Forwarded-For values separately — exhausting one IP's limit never affects another IP", async () => {
    const app = buildLimitedApp(2);
    const ipA = "203.0.113.10";
    const ipB = "203.0.113.20";

    const firstForA = await request(app).get("/limited").set("X-Forwarded-For", ipA);
    const secondForA = await request(app).get("/limited").set("X-Forwarded-For", ipA);
    const thirdForA = await request(app).get("/limited").set("X-Forwarded-For", ipA);
    expect(firstForA.status).toBe(200);
    expect(secondForA.status).toBe(200);
    expect(thirdForA.status, "IP A's third request should be rate-limited").toBe(429);

    // IP B has made zero requests so far — its own bucket must be untouched
    // by IP A's, not shared as if every request came from the proxy.
    const firstForB = await request(app).get("/limited").set("X-Forwarded-For", ipB);
    const secondForB = await request(app).get("/limited").set("X-Forwarded-For", ipB);
    expect(firstForB.status, "IP B must not inherit IP A's exhausted bucket").toBe(200);
    expect(secondForB.status).toBe(200);

    // And IP A is still limited — proves the two buckets are genuinely
    // independent in both directions, not just "B happened to go first".
    const fourthForA = await request(app).get("/limited").set("X-Forwarded-For", ipA);
    expect(fourthForA.status).toBe(429);
  });

  it("without trust proxy configured, X-Forwarded-For is ignored and every request shares one bucket", async () => {
    // The negative case: proves the setting above is load-bearing, not
    // incidental — this is the exact misconfiguration app.ts's comment on
    // trust proxy warns about.
    const app = express();
    app.use("/limited", rateLimit({ windowMs: 60_000, limit: 1, standardHeaders: true, legacyHeaders: false }));
    app.get("/limited", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const first = await request(app).get("/limited").set("X-Forwarded-For", "203.0.113.10");
    expect(first.status).toBe(200);

    // A genuinely different client IP, but with no trust proxy, Express
    // never looks at X-Forwarded-For — both requests resolve to the same
    // loopback peer address and collide in the same bucket.
    const second = await request(app).get("/limited").set("X-Forwarded-For", "203.0.113.20");
    expect(second.status, "with no trust proxy, a different X-Forwarded-For still shares the one bucket").toBe(429);
  });
});
