// Permanently removes every Parent soft-deleted more than
// PARENT_PURGE_AFTER_DAYS ago — see parents.service.ts's
// purgeDeletedParents. Meant to run once a day as a Railway cron service
// (same image, start command `npm run purge:parents`); safe to run more
// often or by hand, since a run with nothing past the cutoff is a no-op.
import { prisma } from "../src/db/client.js";
import { purgeDeletedParents } from "../src/modules/parents/parents.service.js";

async function main() {
  const { purged, cutoff } = await purgeDeletedParents();
  console.log(`Purged ${purged} parent(s) soft-deleted before ${cutoff.toISOString()}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
