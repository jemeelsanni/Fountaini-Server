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

async function main() {
  await seedAdmin();
  await seedSurahs();
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
