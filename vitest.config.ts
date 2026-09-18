import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // All test files share one real Postgres test DB with a per-test
    // resetDb() truncate — running files in parallel lets one file's reset
    // wipe rows another file's in-flight request depends on.
    //
    // fileParallelism: false alone was NOT sufficient — Vitest still spawns
    // one process per test file (confirmed: 14 distinct PIDs for 14 files
    // even with it set), and imperfect boundary sync between a finishing
    // process and the next one starting produced real, intermittent
    // cross-file failures. `poolOptions.forks.singleFork` (the Vitest 3 way
    // to force this) was silently a no-op here too — it was removed in
    // Vitest 4 in favor of maxWorkers. This combination is what actually
    // pins everything to one process: one Node process, one event loop,
    // fully sequential. Revisit with a per-worker isolated schema if the
    // suite's size makes this noticeably slow.
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    // requireAuth now does one extra DB round-trip per authenticated
    // request (the mustChangePassword check — see authorization/
    // middleware.ts) to satisfy a genuine correctness requirement (it must
    // take effect on the very next request after change-password, within
    // the same still-valid access token, so it can't be cached in the
    // JWT). That's real, permanent added latency on every one of the many
    // sequential HTTP calls a test like authMatrix.test.ts's per-row cases
    // makes. NOTE: a small (3-run) before/after comparison while adding
    // this looked like it confirmed the extra query was newly causing
    // authMatrix.test.ts timeouts — but see docs/concurrency.md's "Known
    // intermittent test failure": that exact symptom (5000ms timeouts and
    // `Parse Error: Expected HTTP/` on authMatrix.test.ts rows
    // specifically) is an already-documented, unexplained, ~20%-of-runs
    // flake with cause "unknown," predating this batch entirely — a 3-run
    // sample can't distinguish "caused by this change" from "that flake
    // fired." Bumped the timeout anyway, since the added per-request cost
    // is real regardless; just not claiming it as a confirmed fix for a
    // flake this small a sample can't actually attribute.
    testTimeout: 10_000,
  },
});
