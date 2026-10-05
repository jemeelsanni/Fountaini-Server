import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { createParent } from "../../test/factories.js";
import { resetDb } from "../../test/resetDb.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

const MIGRATION_SQL_PATH = fileURLToPath(
  new URL(
    "../../../prisma/migrations/20261005120000_add_notification_sensitive_flag/migration.sql",
    import.meta.url,
  ),
);

/// Re-runs the migration's own scrub UPDATE directly from the migration
/// file on disk — not a hand-copied duplicate that could silently drift
/// from the real statement — against rows constructed to look exactly like
/// what existed before this migration first ran: `sensitive` at its column
/// default (false) and `body` still holding the real secret text. The
/// ADD COLUMN statement earlier in the same file is deliberately NOT
/// re-run here — it already applied for real when this test database's
/// migrations were deployed, and running it twice would error (column
/// already exists) — this isolates exactly the part under test.
function reRunScrubStatement(): Promise<unknown> {
  const sql = readFileSync(MIGRATION_SQL_PATH, "utf-8");
  const updateStatement = sql.slice(sql.indexOf('UPDATE "NotificationEvent"'));
  expect(updateStatement, "the scrub UPDATE statement must still be present in the migration file").toContain(
    "redacted",
  );
  return prisma.$executeRawUnsafe(updateStatement);
}

describe("migration 20261005120000_add_notification_sensitive_flag's scrub step", () => {
  it("scrubs pre-existing CREDENTIALS_ISSUED and PASSWORD_RESET rows, and leaves every other type untouched", async () => {
    const { parent } = await createParent("parent@test.local");

    const dirtyCredentials = await prisma.notificationEvent.create({
      data: {
        type: "CREDENTIALS_ISSUED",
        recipientUserId: parent.userId,
        subject: "Your school portal login",
        body: "Your login ID is parent@test.local. Temporary password: REAL-SECRET-VALUE-1. You'll be asked to change it.",
        // sensitive left at its column default (false) — simulating a row
        // written before this migration (and the application-layer
        // scrubbing it introduced) ever existed.
      },
    });
    const dirtyReset = await prisma.notificationEvent.create({
      data: {
        type: "PASSWORD_RESET",
        recipientUserId: parent.userId,
        subject: "Reset your password",
        body: "Submit the following token to POST /api/auth/reset-password: REAL-RESET-TOKEN-VALUE-1",
      },
    });
    const untouched = await prisma.notificationEvent.create({
      data: {
        type: "ADMIN_GENERAL",
        recipientUserId: parent.userId,
        subject: "Hello",
        body: "An ordinary, non-sensitive announcement.",
      },
    });

    await reRunScrubStatement();

    const refreshedCredentials = await prisma.notificationEvent.findUniqueOrThrow({
      where: { id: dirtyCredentials.id },
    });
    expect(refreshedCredentials.sensitive).toBe(true);
    expect(refreshedCredentials.body).toBe("[redacted — sensitive content, not stored]");
    expect(refreshedCredentials.body).not.toContain("REAL-SECRET-VALUE-1");

    const refreshedReset = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: dirtyReset.id } });
    expect(refreshedReset.sensitive).toBe(true);
    expect(refreshedReset.body).toBe("[redacted — sensitive content, not stored]");
    expect(refreshedReset.body).not.toContain("REAL-RESET-TOKEN-VALUE-1");

    const refreshedUntouched = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(refreshedUntouched.sensitive).toBe(false);
    expect(refreshedUntouched.body).toBe("An ordinary, non-sensitive announcement.");
  });

  it("is idempotent — running it twice leaves already-scrubbed rows unchanged", async () => {
    const { parent } = await createParent("parent@test.local");
    const event = await prisma.notificationEvent.create({
      data: {
        type: "CREDENTIALS_ISSUED",
        recipientUserId: parent.userId,
        subject: "Your school portal login",
        body: "Temporary password: REAL-SECRET-VALUE-2",
      },
    });

    await reRunScrubStatement();
    const afterFirst = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: event.id } });

    await reRunScrubStatement();
    const afterSecond = await prisma.notificationEvent.findUniqueOrThrow({ where: { id: event.id } });

    expect(afterSecond).toEqual(afterFirst);
  });
});
