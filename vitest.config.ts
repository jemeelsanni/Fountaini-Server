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
  },
});
