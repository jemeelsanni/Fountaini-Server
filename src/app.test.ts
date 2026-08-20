import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { env } from "./config/env.js";

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("CORS", () => {
  it("returns 403 with the FORBIDDEN code for a disallowed Origin", async () => {
    // env.CORS_ORIGINS is unset in the test environment (see .env.test),
    // which means "allow any origin" — the same wide-open behavior as
    // outside production. Set a real allowlist for the duration of this
    // one test so there's something for the Origin below to be excluded
    // from, then restore it: env is parsed once from process.env at
    // module load, so this is the only way to exercise the "disallowed"
    // branch at all, not just a convenience.
    const original = env.CORS_ORIGINS;
    env.CORS_ORIGINS = ["https://allowed.example.com"];
    try {
      const app = createApp();
      const response = await request(app).get("/health").set("Origin", "https://evil.example.com");

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      env.CORS_ORIGINS = original;
    }
  });
});

describe("unmatched routes", () => {
  it("returns 404 for an unknown path", async () => {
    const app = createApp();
    const response = await request(app).get("/does-not-exist");

    expect(response.status).toBe(404);
  });
});
