import { PrismaClient } from "../generated/prisma/index.js";
import { seedAdmin } from "../src/lib/seedAdmin.js";
import { SURAHS } from "./surahData.js";

const prisma = new PrismaClient();

async function seedSurahs() {
  for (const surah of SURAHS) {
    await prisma.surah.upsert({
      where: { number: surah.number },
      update: { name: surah.name, englishName: surah.englishName, totalAyahs: surah.totalAyahs },
      create: surah,
    });
  }
  console.log(`Seeded ${SURAHS.length} surahs.`);
}

const RATING_SCALE_LEVELS = [
  { value: 5, label: "Excellent" },
  { value: 4, label: "Very Good" },
  { value: 3, label: "Good" },
  { value: 2, label: "Fair" },
  { value: 1, label: "Poor" },
];

/// Static reference data (5 rows), shared by both trait categories —
/// same "seeded once" treatment as seedSurahs above.
async function seedRatingScale() {
  for (const level of RATING_SCALE_LEVELS) {
    await prisma.ratingScaleLevel.upsert({
      where: { value: level.value },
      update: { label: level.label },
      create: level,
    });
  }
  console.log(`Seeded ${RATING_SCALE_LEVELS.length} rating scale levels.`);
}

async function main() {
  await seedAdmin();
  await seedSurahs();
  await seedRatingScale();
  // Trait seeding moved to `npm run db:seed:traits` (prisma/seedTraits.ts)
  // — it's session-scoped, and no session exists yet at the point this
  // script normally runs (right after a reset, before any school
  // configuration). Run that separately, any time a session becomes
  // current and needs its default trait lists populated — it fails loudly
  // instead of silently skipping if none is current, unlike this script's
  // old inline version did.
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
