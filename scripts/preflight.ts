// Runs the exact same checklist as GET /api/admin/setup-status, against
// whatever DATABASE_URL is set in the environment this is invoked from —
// including production, which is the whole point: an admin (never this
// agent — see the go-live runbook's own boundary) points this at the real
// database before/after each go-live step and gets a readable table plus a
// real exit code a CI/deploy script could also gate on.
import { getSetupStatus } from "../src/modules/admin/admin.service.js";

const STATUS_LABEL: Record<string, string> = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN" };

async function main() {
  const { ready, checks } = await getSetupStatus();

  for (const check of checks) {
    console.log(`[${STATUS_LABEL[check.status]}] ${check.label}`);
    console.log(`       ${check.message}`);
    if (check.fixHint) {
      console.log(`       Fix: ${check.fixHint}`);
    }
  }

  console.log("");
  console.log(
    ready
      ? "READY — no blocking checks failed. (WARN rows above are advisory, not blocking.)"
      : "NOT READY — one or more checks FAILed. See the FAIL rows above.",
  );

  process.exitCode = ready ? 0 : 1;
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    import("../src/db/client.js")
      .then(({ prisma }) => prisma.$disconnect())
      .catch(() => {
        // Nothing left to clean up if the client itself never loaded.
      });
  });
