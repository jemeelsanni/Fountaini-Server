// A habit-forming guard, not a lock — see docs/go-live.md. Running
// `prisma migrate reset` directly still works; this just makes the ordinary
// path (`npm run db:reset`) refuse to discard real records by accident.
//
// Plain form: exits non-zero if the database holds ANY student, parent,
// payment, result, score, or staff (with a staff number — see
// dbEmptyCheck.ts's own comment) row. --allow-demo-only: exits zero instead
// when every such row traces back to prisma/demo-seed-manifest.json —
// refuses unconditionally if that manifest is missing, since nothing can be
// verified against it then.
import { fileURLToPath } from "node:url";
import { prisma } from "../src/db/client.js";
import { checkDbEmpty, type DbRowCounts } from "../src/lib/dbEmptyCheck.js";

function printCounts(counts: DbRowCounts): void {
  for (const [key, count] of Object.entries(counts)) {
    console.log(`  ${key}: ${count}`);
  }
}

async function main() {
  const allowDemoOnly = process.argv.includes("--allow-demo-only");
  const manifestPath = fileURLToPath(new URL("../prisma/demo-seed-manifest.json", import.meta.url));

  const result = await checkDbEmpty({ allowDemoOnly, manifestPath });

  console.log("Row counts:");
  printCounts(result.counts);

  if (result.empty) {
    console.log("\nDatabase is empty. OK.");
    process.exitCode = 0;
    return;
  }

  if (!allowDemoOnly) {
    console.error("\nDatabase is NOT empty, and --allow-demo-only was not given. Refusing.");
    process.exitCode = 1;
    return;
  }

  if (result.manifestMissing) {
    console.error(
      "\n--allow-demo-only given, but prisma/demo-seed-manifest.json is missing — cannot verify " +
        "these rows are demo data. Refusing.",
    );
    process.exitCode = 1;
    return;
  }

  if (!result.allowedByManifest) {
    console.error("\nRows exist that are NOT listed in the demo seed manifest:");
    printCounts(result.unaccounted!);
    process.exitCode = 1;
    return;
  }

  console.log("\nEvery row present is accounted for by the demo seed manifest. OK (--allow-demo-only).");
  process.exitCode = 0;
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
