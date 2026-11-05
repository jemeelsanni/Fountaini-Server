import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url(),
  // Overrides Prisma's own default $transaction timeout (5000ms) for every
  // transaction made through this process's client — read once here, not
  // threaded through individual $transaction calls or service-function
  // signatures, so a script's own connection-latency concern never leaks
  // into a production code path's parameters. Left unset in production:
  // the deployed app's own server-to-database traffic runs over Railway's
  // internal network regardless of a caller's own connection quality, so
  // 5000ms is already generous there. Set explicitly by prisma/seed-demo.ts
  // and prisma/wipe-demo.ts before their first import of anything that
  // constructs the client (same env.ts-must-load-after ordering constraint
  // as NOTIFICATION_PROVIDER, see those scripts' own comments) — both run
  // directly against Railway's public proxy, where a single round trip has
  // been measured at 320-700ms, and several of the transactions on their
  // path run 6-14 round trips.
  DB_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Overrides Prisma's own default $transaction maxWait (2000ms) — how
  // long Prisma will wait to acquire a connection and actually start the
  // transaction (send BEGIN), separate from `timeout` above, which only
  // starts counting once the transaction is already open. This is the one
  // that actually mattered for the seed: a cold connection to Railway's
  // public proxy measured at 2.2-3.4s for its very first round trip,
  // which is *already past* the 2000ms default before a single query
  // inside the transaction ever runs — raising `timeout` alone doesn't
  // touch this, since it never gets that far. Same unset-in-production
  // default and same script-only scope as DB_TRANSACTION_TIMEOUT_MS.
  DB_TRANSACTION_MAX_WAIT_MS: z.coerce.number().int().positive().optional(),
  // Seed-only kill switch for CREDENTIALS_ISSUED notifications
  // specifically (not notifications generally — see
  // notifications.service.ts's own comment on where this is read). Every
  // demo account's email is @example.com (undeliverable by design) and its
  // credentials are already in the printed/written table, so there is no
  // value in also writing a NotificationEvent + NotificationDelivery row
  // per account — only more round trips on an already-slow link.
  SUPPRESS_CREDENTIAL_NOTIFICATIONS: z.enum(["true", "false"]).optional(),
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
  // Comma-separated allowlist of origins CORS may accept, e.g.
  // "https://app.example.com,https://staff.example.com" — Railway issues a
  // distinct URL per environment (preview/staging/prod), so this needs to
  // support more than one entry, not just one. Optional outside production
  // (unset means "allow any origin", the old cors()-with-no-options
  // behavior, which is fine for local dev); required in production — see
  // the superRefine below, which is what makes an unset CORS_ORIGINS in
  // production a startup failure instead of a silently-wide-open API.
  CORS_ORIGINS: z.string().optional(),
  // "console" (the default) just logs — nothing is actually delivered, so
  // it must never be selected in production; see the superRefine below.
  // "resend" sends real email via ResendNotificationProvider.
  NOTIFICATION_PROVIDER: z.enum(["console", "resend"]).default("console"),
  // Required only when NOTIFICATION_PROVIDER=resend — see the superRefine
  // below. Never defaulted: this is a secret, not a convenience value.
  RESEND_API_KEY: z.string().optional(),
  // The verified fountaini.academy sending address. Has a real default
  // (unlike RESEND_API_KEY) since it isn't a secret and Resend requires the
  // domain to be verified either way; override for a display name, e.g.
  // "Fountaini Academy <no-reply@fountaini.academy>".
  EMAIL_FROM_ADDRESS: z.string().default("no-reply@fountaini.academy"),
});

const parsedEnv = envSchema
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === "production" && !data.CORS_ORIGINS) {
      ctx.addIssue({
        code: "custom",
        path: ["CORS_ORIGINS"],
        message:
          "CORS_ORIGINS must be set in production — a comma-separated list of allowed origins. " +
          "Refusing to start with CORS wide-open in production by default.",
      });
    }
    if (data.NODE_ENV === "production" && data.NOTIFICATION_PROVIDER !== "resend") {
      ctx.addIssue({
        code: "custom",
        path: ["NOTIFICATION_PROVIDER"],
        message:
          'NOTIFICATION_PROVIDER must be "resend" in production — the console provider only logs messages, ' +
          "so no user would ever actually receive a password reset email or any other notification.",
      });
    }
    if (data.NOTIFICATION_PROVIDER === "resend" && !data.RESEND_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_API_KEY"],
        message: "RESEND_API_KEY must be set when NOTIFICATION_PROVIDER=resend.",
      });
    }
  })
  .parse(process.env);

export const env = {
  ...parsedEnv,
  // /api/docs and /api/openapi.json publish `x-roles` for every route — a
  // complete authorization map of the API — so this is on by default
  // everywhere except production; only an explicit DOCS_ENABLED overrides
  // that default in either direction.
  DOCS_ENABLED: parsedEnv.DOCS_ENABLED ? parsedEnv.DOCS_ENABLED === "true" : parsedEnv.NODE_ENV !== "production",
  // Parsed once here rather than in app.ts, so app.ts's CORS config is a
  // plain array lookup — undefined/empty means "no allowlist configured",
  // which the superRefine above guarantees can't happen in production.
  CORS_ORIGINS: parsedEnv.CORS_ORIGINS
    ? parsedEnv.CORS_ORIGINS.split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : undefined,
};
