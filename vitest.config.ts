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
    // NOT because of requireAuth's mustChangePassword check: that extra
    // per-request DB round-trip was measured directly at ~0.3ms avg
    // (docs/concurrency.md, "2026-09-19 measurement") — noise, confirmed
    // not to be the reason this needed raising. Kept at 10s anyway: briefly
    // reverted to Vitest's 5000ms default to test that theory, and a 3-run
    // check at the default produced a genuine `Test timed out in 5000ms`
    // on fees.test.ts (not even an auth-heavy test) in 1/3 runs — direct,
    // fresh evidence that the pre-existing, unrelated, unexplained flake
    // documented in docs/concurrency.md really does manifest as hard
    // timeouts at the default, not just as the malformed-response symptoms
    // also on file there. 10s doesn't fix that flake's cause, but measurably
    // reduces how often it surfaces as a failed run.
    testTimeout: 10_000,
  },
});
