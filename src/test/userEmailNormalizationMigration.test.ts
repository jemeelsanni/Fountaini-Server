import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import { resetDb } from "./resetDb.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

const MIGRATION_SQL_PATH = fileURLToPath(
  new URL(
    "../../prisma/migrations/20261007090100_normalize_user_email_login_id/migration.sql",
    import.meta.url,
  ),
);

// $executeRawUnsafe runs over Postgres's prepared-statement protocol,
// which (unlike `prisma migrate deploy`'s simple-query execution of the
// whole file) refuses multiple commands in one call — this migration has
// two separate WITH...UPDATE statements, so each is re-run as its own call.
async function reRunMigration(): Promise<void> {
  const sql = readFileSync(MIGRATION_SQL_PATH, "utf-8");
  const emailStatement = sql.slice(sql.indexOf('WITH ranked_emails'), sql.indexOf('WITH ranked_login_ids'));
  const loginIdStatement = sql.slice(sql.indexOf('WITH ranked_login_ids'));
  await prisma.$executeRawUnsafe(emailStatement);
  await prisma.$executeRawUnsafe(loginIdStatement);
}

describe("migration 20261007090100_normalize_user_email_login_id", () => {
  it("lowercases and trims email and loginId for a parent-shaped (bare) account", async () => {
    const user = await prisma.user.create({
      data: {
        loginId: "  Mixed.Case@Test.Local  ",
        email: "  Mixed.Case@Test.Local  ",
        passwordHash: "x",
        roles: { create: [{ role: "PARENT" }] },
      },
    });

    await reRunMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe("mixed.case@test.local");
    expect(after.loginId).toBe("mixed.case@test.local");
  });

  it("normalizes email but leaves a staff member's loginId (staff number) untouched", async () => {
    const user = await prisma.user.create({
      data: {
        loginId: "FIA/ST2026/001",
        email: "  Teacher@Test.Local  ",
        passwordHash: "x",
        roles: { create: [{ role: "TEACHER" }] },
      },
    });
    await prisma.staff.create({
      data: { userId: user.id, staffNumber: "FIA/ST2026/001", firstName: "Test", lastName: "Teacher" },
    });

    await reRunMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.email).toBe("teacher@test.local");
    expect(after.loginId).toBe("FIA/ST2026/001");
  });

  it("self-heals a genuine case-collision: normalizes the earliest row, leaves the other untouched and still reachable", async () => {
    const earliest = await prisma.user.create({
      data: {
        loginId: "Collide@Test.Local",
        email: "Collide@Test.Local",
        passwordHash: "x",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        roles: { create: [{ role: "PARENT" }] },
      },
    });
    const later = await prisma.user.create({
      data: {
        loginId: "collide@test.local".toUpperCase(), // distinct raw value, same normalized form
        email: "collide@test.local".toUpperCase(),
        passwordHash: "x",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        roles: { create: [{ role: "PARENT" }] },
      },
    });

    await reRunMigration();

    const earliestAfter = await prisma.user.findUniqueOrThrow({ where: { id: earliest.id } });
    const laterAfter = await prisma.user.findUniqueOrThrow({ where: { id: later.id } });

    expect(earliestAfter.email).toBe("collide@test.local");
    expect(earliestAfter.loginId).toBe("collide@test.local");
    // The later row is left exactly as it was — never merged, renamed, or
    // nulled — so its owner's login path still works.
    expect(laterAfter.email).toBe("COLLIDE@TEST.LOCAL");
    expect(laterAfter.loginId).toBe("COLLIDE@TEST.LOCAL");
  });

  it("is idempotent — running it twice leaves already-normalized rows unchanged", async () => {
    const user = await prisma.user.create({
      data: {
        loginId: "  Idempotent@Test.Local  ",
        email: "  Idempotent@Test.Local  ",
        passwordHash: "x",
        roles: { create: [{ role: "PARENT" }] },
      },
    });

    await reRunMigration();
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    await reRunMigration();
    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(afterSecond).toEqual(afterFirst);
  });
});
