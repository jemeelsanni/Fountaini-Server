import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db/client.js";
import { createBareStudent, createParent, createTeacher } from "./factories.js";
import { resetDb } from "./resetDb.js";

beforeEach(async () => {
  await resetDb();
});

/// Re-runs migration 20260918120214_add_login_id_and_identifier_counters's
/// first two backfill UPDATEs (Staff -> loginId, then Student -> loginId)
/// against whatever's currently in the table. The real migration's third
/// step ("loginId = email WHERE loginId IS NULL") can't be replayed the
/// same way — loginId is NOT NULL now, so no row can ever be put back into
/// a genuinely pre-migration NULL state to re-derive it from; that rule is
/// instead confirmed directly below by asserting the invariant it produced
/// still holds for a parent (loginId already equals email).
async function rerunStaffAndStudentBackfillSteps() {
  await prisma.$executeRaw`
    UPDATE "User" u
    SET "loginId" = s."staffNumber"
    FROM "Staff" s
    WHERE s."userId" = u."id"
  `;
  await prisma.$executeRaw`
    UPDATE "User" u
    SET "loginId" = st."admissionNumber"
    FROM "Student" st
    WHERE st."userId" = u."id"
  `;
}

describe("loginId backfill (migration 20260918120214)", () => {
  it("derives the right loginId for a staff member and a student when re-run against corrupted data", async () => {
    const { staff } = await createTeacher("teacher@test.local");
    const student = await createBareStudent("FIA/2026/001");
    const studentUser = await prisma.user.create({
      data: { loginId: "placeholder", email: null, passwordHash: "unused", roles: { create: [{ role: "STUDENT" }] } },
    });
    await prisma.student.update({ where: { id: student.id }, data: { userId: studentUser.id } });

    // Corrupt every loginId first (distinct values — loginId is still
    // unique), so the re-run's assertions can't trivially pass because
    // nothing ever actually changed.
    await prisma.user.update({ where: { id: staff.userId }, data: { loginId: "CORRUPTED-1" } });
    await prisma.user.update({ where: { id: studentUser.id }, data: { loginId: "CORRUPTED-2" } });

    await rerunStaffAndStudentBackfillSteps();

    const staffUser = await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } });
    expect(staffUser.loginId).toBe(staff.staffNumber);

    const refreshedStudentUser = await prisma.user.findUniqueOrThrow({ where: { id: studentUser.id } });
    expect(refreshedStudentUser.loginId).toBe(student.admissionNumber);
  });

  it("a parent (never touched by the Staff/Student steps) keeps loginId equal to email", async () => {
    const { parent } = await createParent("parent@test.local");
    const parentUser = await prisma.user.findUniqueOrThrow({ where: { id: parent.userId } });
    expect(parentUser.loginId).toBe(parentUser.email);
  });
});

/// Migration 20260918120214 failed against production on first deploy: at
/// least one student already had more than one StudentParent row with
/// isPrimaryContact = true, predating the partial unique index the
/// migration creates to enforce "at most one" — nothing before that index
/// existed stopped it. The fix adds a dedup UPDATE ahead of the CREATE
/// UNIQUE INDEX (see the migration's own comment). This re-runs that exact
/// statement the same way the describe block above re-runs the loginId
/// backfill: against the current (already-migrated) schema, corrupting
/// data the schema would otherwise refuse to hold. The corruption here is
/// schema-level, not just row-level, though — the whole point of the
/// duplicate state is that the index blocks it — so this drops the index
/// first and always restores it in a finally, even if an assertion fails,
/// rather than leaving the constraint silently off for every later test in
/// this process. Also verified directly against a real reproduction of
/// production's failure (all 9 migrations replayed against a throwaway
/// Postgres database, seeded with three isPrimaryContact = true rows for
/// one student, migration re-run) — not part of this automated suite, but
/// confirmed by hand before writing this. Every DDL statement in this
/// migration is IF [NOT] EXISTS for the same reason: confirmed by hand
/// (inside an explicit BEGIN/COMMIT, matching how Prisma actually runs a
/// migration file) that a Postgres 16 rollback on the original failure
/// undid the whole file cleanly, including `ALTER TYPE ... ADD VALUE`
/// (transactional since Postgres 12) — but Prisma's own migration-history
/// bookkeeping still marks a failed attempt as unresolved regardless of
/// the schema's actual state, so the file needs to survive a second
/// attempt either way. Confirmed the full file re-applies successfully
/// twice in a row (fresh, then immediately again) against the same
/// duplicate-primary reproduction above, with no error on the second run.
describe("StudentParent primary-contact dedup (migration 20260918120214)", () => {
  it("keeps the earliest-linked primary-contact row and clears the rest when re-run against corrupted data", async () => {
    const student = await createBareStudent("FIA/2026/900");
    const { parent: parentA } = await createParent("dedup-parent-a@test.local");
    const { parent: parentB } = await createParent("dedup-parent-b@test.local");
    const { parent: parentC } = await createParent("dedup-parent-c@test.local");

    await prisma.$executeRaw`DROP INDEX "StudentParent_one_primary_contact_per_student"`;
    try {
      const earliest = await prisma.studentParent.create({
        data: {
          studentId: student.id,
          parentId: parentA.id,
          relationship: "MOTHER",
          isPrimaryContact: true,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      const middle = await prisma.studentParent.create({
        data: {
          studentId: student.id,
          parentId: parentB.id,
          relationship: "FATHER",
          isPrimaryContact: true,
          createdAt: new Date("2026-02-01T00:00:00Z"),
        },
      });
      const latest = await prisma.studentParent.create({
        data: {
          studentId: student.id,
          parentId: parentC.id,
          relationship: "GUARDIAN",
          isPrimaryContact: true,
          createdAt: new Date("2026-03-01T00:00:00Z"),
        },
      });

      // The migration's own dedup statement, verbatim.
      await prisma.$executeRaw`
        WITH ranked_primary_contacts AS (
          SELECT "id",
                 ROW_NUMBER() OVER (
                   PARTITION BY "studentId"
                   ORDER BY "createdAt" ASC, "id" ASC
                 ) AS rn
          FROM "StudentParent"
          WHERE "isPrimaryContact"
        )
        UPDATE "StudentParent"
        SET "isPrimaryContact" = false
        WHERE "id" IN (SELECT "id" FROM ranked_primary_contacts WHERE rn > 1)
      `;

      const refreshed = await prisma.studentParent.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: "asc" },
      });
      expect(refreshed.find((l) => l.id === earliest.id)?.isPrimaryContact).toBe(true);
      expect(refreshed.find((l) => l.id === middle.id)?.isPrimaryContact).toBe(false);
      expect(refreshed.find((l) => l.id === latest.id)?.isPrimaryContact).toBe(false);
    } finally {
      // Re-creating the index here isn't just teardown — it's also part of
      // the assertion: this is the exact statement the migration itself
      // runs immediately after the dedup, and it throws if any student
      // still has more than one row flagged true. A dedup bug that left
      // duplicates behind would fail here, not just at the expect() calls
      // above.
      await prisma.$executeRaw`CREATE UNIQUE INDEX "StudentParent_one_primary_contact_per_student" ON "StudentParent" ("studentId") WHERE "isPrimaryContact"`;
    }
  });
});
