import argon2 from "argon2";
import { PrismaClient } from "../generated/prisma/index.js";
import { SURAHS } from "./surahData.js";

const prisma = new PrismaClient();

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@school.test";
  const password = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, roles: { create: [{ role: "ADMIN" }] } },
  });

  console.log(`Seeded admin user: ${admin.email} (id: ${admin.id})`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`Default password used: ${password} — set SEED_ADMIN_PASSWORD to override.`);
  }
}

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

const AFFECTIVE_TRAITS = [
  "Punctuality",
  "Attendance",
  "Neatness",
  "Politeness",
  "Honesty",
  "Relationship with others",
  "Attentiveness in class",
  "Self-control",
];

const PSYCHOMOTOR_TRAITS = [
  "Handwriting",
  "Games and Sports",
  "Drawing and Painting",
  "Craftwork",
  "Musical Skills",
  "Verbal Fluency",
];

/// Unlike AssessmentComponent/GradingScale (admin-configured via the API,
/// never seeded), traits are seeded directly for the current session —
/// this batch's own explicit instruction, not a precedent AssessmentComponent
/// itself follows. Skips gracefully (not an error) if no session is marked
/// current yet — a fresh DB before initial school setup, say.
async function seedTraits() {
  const currentSession = await prisma.academicSession.findFirst({ where: { isCurrent: true } });
  if (!currentSession) {
    console.log("No current academic session — skipping trait seeding.");
    return;
  }

  for (const [index, name] of AFFECTIVE_TRAITS.entries()) {
    await prisma.trait.upsert({
      where: {
        academicSessionId_category_name: { academicSessionId: currentSession.id, category: "AFFECTIVE", name },
      },
      update: { order: index + 1 },
      create: { academicSessionId: currentSession.id, category: "AFFECTIVE", name, order: index + 1 },
    });
  }
  for (const [index, name] of PSYCHOMOTOR_TRAITS.entries()) {
    await prisma.trait.upsert({
      where: {
        academicSessionId_category_name: { academicSessionId: currentSession.id, category: "PSYCHOMOTOR", name },
      },
      update: { order: index + 1 },
      create: { academicSessionId: currentSession.id, category: "PSYCHOMOTOR", name, order: index + 1 },
    });
  }
  console.log(
    `Seeded ${AFFECTIVE_TRAITS.length} affective + ${PSYCHOMOTOR_TRAITS.length} psychomotor traits ` +
      `for session ${currentSession.name}.`,
  );
}

async function main() {
  await seedAdmin();
  await seedSurahs();
  await seedRatingScale();
  await seedTraits();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
