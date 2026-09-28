import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import { resetDb } from "./resetDb.js";

/// Runs migration 20260928120000_normalize_phone_numbers's own SQL,
/// verbatim, against whatever's in the test DB right now — same pattern as
/// subjectResultMaxScoreBackfill.test.ts. Shelled out to psql rather than
/// prisma.$executeRawUnsafe(): the migration is a genuine multi-statement
/// script (a temporary function, several DO blocks, a temp table), and
/// Prisma's raw-query methods use the extended/prepared-statement protocol,
/// which Postgres refuses for more than one command at a time ("cannot
/// insert multiple commands into a prepared statement", confirmed
/// directly). psql has no such restriction, and is already a hard
/// dependency of this project's own CI (.github/workflows/ci.yml creates
/// both databases with it before any test runs), so this isn't introducing
/// a new one.
const MIGRATION_SQL_PATH = path.resolve(
  import.meta.dirname,
  "../../prisma/migrations/20260928120000_normalize_phone_numbers/migration.sql",
);

function runMigration(): void {
  const url = new URL(process.env.DATABASE_URL!);
  // libpq (what psql links against) doesn't understand Prisma's own
  // ?schema= query param — the schema is already "public" either way, so
  // dropping it is a no-op, not a behavior change.
  url.search = "";
  execFileSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", "-f", MIGRATION_SQL_PATH], { stdio: "pipe" });
}

async function createBareUser(loginId: string, phone: string | null, createdAt: Date) {
  return prisma.user.create({
    data: { loginId, email: loginId, passwordHash: "unused", phone, createdAt },
  });
}

beforeEach(async () => {
  await resetDb();
});

describe("migration 20260928120000_normalize_phone_numbers", () => {
  it("normalises a differently-formatted-but-valid User.phone value", async () => {
    const user = await createBareUser("plain@test.local", "0801 234 5678", new Date());

    runMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.phone).toBe("+2348012345678");
  });

  it("sets an unnormalisable User.phone value to NULL rather than leaving it malformed", async () => {
    const user = await createBareUser("bad@test.local", "call-the-office", new Date());

    runMigration();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.phone).toBeNull();
  });

  // The chosen collision behaviour (see the migration's own header comment
  // for the justification): the earliest-created row keeps the normalised
  // number, every later row involved in the same collision is set to NULL.
  // Explicit createdAt values, not real-time gaps, so this can never be
  // flaky about which row actually is "earlier".
  it("resolves a User.phone collision by keeping the earliest-created row's number and nulling the rest — never fails the migration", async () => {
    const earliest = await createBareUser("earliest@test.local", "08012345678", new Date("2026-01-01T00:00:00Z"));
    const middle = await createBareUser("middle@test.local", "+2348012345678", new Date("2026-01-02T00:00:00Z"));
    const latest = await createBareUser("latest@test.local", "234 801 234 5678", new Date("2026-01-03T00:00:00Z"));
    // An unrelated, non-colliding number must be untouched by the collision
    // handling above — proves the dedup is scoped to the actual collision
    // group (partitioned by normalised value), not applied suite-wide.
    const unrelated = await createBareUser("unrelated@test.local", "0701 234 5678", new Date("2026-01-01T12:00:00Z"));

    expect(() => runMigration()).not.toThrow();

    const [earliestAfter, middleAfter, latestAfter, unrelatedAfter] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: earliest.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: middle.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: latest.id } }),
      prisma.user.findUniqueOrThrow({ where: { id: unrelated.id } }),
    ]);

    expect(earliestAfter.phone).toBe("+2348012345678");
    expect(middleAfter.phone).toBeNull();
    expect(latestAfter.phone).toBeNull();
    expect(unrelatedAfter.phone).toBe("+2347012345678");

    // The unique index itself must still hold — not just "no error was
    // thrown", but the actual invariant the migration exists to protect.
    const phones = await prisma.user.findMany({ where: { phone: { not: null } }, select: { phone: true } });
    const values = phones.map((p) => p.phone);
    expect(new Set(values).size).toBe(values.length);
  });

  it("normalises Parent.phone/alternatePhone and School.contactPhone, with no collision risk (neither is unique)", async () => {
    const user = await createBareUser("parent-owner@test.local", null, new Date());
    const parent = await prisma.parent.create({
      data: { userId: user.id, firstName: "A", lastName: "B", phone: "0801-234-5678", alternatePhone: "junk" },
    });
    const school = await prisma.school.create({ data: { name: "Test School", contactPhone: "234 802 000 0000" } });

    runMigration();

    const parentAfter = await prisma.parent.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentAfter.phone).toBe("+2348012345678");
    expect(parentAfter.alternatePhone).toBeNull();

    const schoolAfter = await prisma.school.findUniqueOrThrow({ where: { id: school.id } });
    expect(schoolAfter.contactPhone).toBe("+2348020000000");
  });

  // AdmissionEnquiry.parentPhone is NOT NULL — an unnormalisable existing
  // value can't be nulled without violating that constraint, so it's left
  // exactly as it was (see the migration's own comment) rather than either
  // breaking the migration or silently blanking a required contact field.
  it("leaves an unnormalisable AdmissionEnquiry.parentPhone unchanged, since the column is NOT NULL", async () => {
    const enquiry = await prisma.admissionEnquiry.create({
      data: {
        prospectiveFirstName: "X",
        prospectiveLastName: "Y",
        parentFullName: "Z",
        parentPhone: "ring-the-bell",
      },
    });

    runMigration();

    const after = await prisma.admissionEnquiry.findUniqueOrThrow({ where: { id: enquiry.id } });
    expect(after.parentPhone).toBe("ring-the-bell");
  });

  it("is idempotent — running it twice against already-normalised data changes nothing and never errors", async () => {
    const user = await createBareUser("idempotent@test.local", "08012345678", new Date());

    runMigration();
    expect(() => runMigration()).not.toThrow();

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.phone).toBe("+2348012345678");
  });
});
