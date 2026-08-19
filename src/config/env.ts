import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  // 15 min access tokens, 30 day refresh tokens with rotation — standard
  // defaults, overridable per-environment without any code change.
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // The OpenAPI document's `servers` entry (src/openapi) — deliberately not
  // derived from PORT/req.host, so the generated spec is correct however
  // it's actually reached (behind Railway's HTTPS edge, a different port,
  // a proxy path) rather than whatever this process happens to think its
  // own address is. Defaults to localhost so `npm run dev` works with zero
  // config; set explicitly in every deployed environment.
  PUBLIC_BASE_URL: z.url().default("http://localhost:4000"),
  // Left unset here (not `.default(...)`) rather than defaulted directly —
  // its default depends on NODE_ENV, computed below. z.coerce.boolean()
  // would also be the wrong tool for this even without that: it treats any
  // non-empty string, including the literal text "false", as true.
  DOCS_ENABLED: z.enum(["true", "false"]).optional(),
});

const parsedEnv = envSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  // /api/docs and /api/openapi.json publish `x-roles` for every route — a
  // complete authorization map of the API — so this is on by default
  // everywhere except production; only an explicit DOCS_ENABLED overrides
  // that default in either direction.
  DOCS_ENABLED: parsedEnv.DOCS_ENABLED ? parsedEnv.DOCS_ENABLED === "true" : parsedEnv.NODE_ENV !== "production",
};
