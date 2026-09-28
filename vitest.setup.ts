import { config } from "dotenv";

// Diagnostic instrumentation for transport-level test flakes (hard
// timeouts, socket hang ups, malformed responses) — off unless
// FLAKE_DIAGNOSTICS=1, a no-op otherwise. This is what found the root cause
// documented in docs/concurrency.md's "2026-09-28 — Root cause found and
// fixed" entry; kept for the next time something in this shape shows up.
// See src/test/flakeInstrument.mjs for what it captures and FLAKE_LOG_PATH
// for where it writes.
if (process.env.FLAKE_DIAGNOSTICS === "1") {
  await import("./src/test/flakeInstrument.mjs");
}

// .env.test is the portable, committed default (matches docker-compose.yml).
// .env.test.local (gitignored) lets this machine override it — e.g. a local
// Postgres.app install with different credentials — without touching the
// committed file. dotenv does not overwrite already-set vars, so the local
// file must load first to win.
config({ path: ".env.test.local" });
config({ path: ".env.test" });

// Dynamic imports, not static ones: db/client.ts reads DATABASE_URL from
// process.env at module-load time, and static ESM imports are hoisted ahead
// of the config() calls above — a static import here would read env vars
// before they're set. Deferring via await import() preserves ordering.
const { prisma } = await import("./src/db/client.js");
const { SURAHS } = await import("./prisma/surahData.js");

// Static reference data (Surah) is seeded here rather than relying on
// someone having manually run `db:seed` against the test database — a fresh
// clone or a CI run starts with an empty test DB otherwise. resetDb()
// deliberately never touches this table (it's not per-test fixture data),
// and this upsert is idempotent, so it's safe and fast on every run.
for (const surah of SURAHS) {
  await prisma.surah.upsert({
    where: { number: surah.number },
    update: {},
    create: surah,
  });
}
