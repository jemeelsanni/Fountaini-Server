-- Hand-written rather than `prisma migrate dev`-generated: this migration
-- backfills existing rows (User.loginId, derived per-user from whichever
-- record is linked) before making the column NOT NULL/UNIQUE, which
-- Prisma's schema-diff tooling can't express — same reasoning as the
-- multi_role_users migration. `prisma migrate dev` also refuses to run
-- non-interactively once it detects the "unique constraint may fail on
-- existing duplicates" warning below.
--
-- Every DDL statement in this file is written IF [NOT] EXISTS / idempotent
-- on purpose: this migration already failed once against production (the
-- StudentParent duplicate-primary issue fixed below) and needed a second
-- deploy attempt. Verified directly (not just reasoned about) that a
-- Postgres 16 ROLLBACK on the original failure fully undid every earlier
-- statement in this file, including `ALTER TYPE ... ADD VALUE` — which is
-- fully transactional as of Postgres 12, unlike in older versions — so a
-- clean retry from scratch was already safe. This layer is for whatever
-- that reasoning didn't cover: Prisma's own migration-history bookkeeping
-- marks a failed attempt as unresolved regardless of the schema's actual
-- state, and a future failure in this same file (or a manual intervention
-- in response to one) might not roll back as cleanly. Every statement here
-- can now be re-run against a database that already has some or all of it,
-- with no error either way.

-- ---------------------------------------------------------------------------
-- IdentifierCounter — race-safe admission/staff number sequences
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "IdentifierCounter" (
    "prefix" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IdentifierCounter_pkey" PRIMARY KEY ("prefix")
);

-- ---------------------------------------------------------------------------
-- User.loginId — backfill before NOT NULL/UNIQUE
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "loginId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Staff first, then Student, then whatever's left (Parent, or a bare
-- account with no linked record) falls back to email — exactly the table
-- in the batch spec, applied to every row that already exists.
UPDATE "User" u
SET "loginId" = s."staffNumber"
FROM "Staff" s
WHERE s."userId" = u."id";

UPDATE "User" u
SET "loginId" = st."admissionNumber"
FROM "Student" st
WHERE st."userId" = u."id" AND u."loginId" IS NULL;

UPDATE "User"
SET "loginId" = "email"
WHERE "loginId" IS NULL;

-- Last-resort fallback: a row still NULL here has no Staff link, no
-- Student link, and no email of its own. Nothing in this system's
-- application history should be able to produce that state (parent/staff/
-- bare-admin creation has always required an email; students are covered
-- by the admissionNumber step above regardless of their own email), but
-- nothing at the DB level has ever enforced it either — User.email has
-- always been nullable (see its own schema comment), so a legacy row, a
-- direct DB fix from an old incident, or a future restore this reasoning
-- turns out to be wrong about could still hit it. Without this, the SET
-- NOT NULL below would fail the same way the StudentParent index below it
-- just did in production. Falling back to the row's own id is safe both
-- ways: always present (it's the primary key) and structurally unable to
-- collide with a staffNumber/admissionNumber/email (cuids contain neither
-- "@" nor "/").
UPDATE "User"
SET "loginId" = "id"
WHERE "loginId" IS NULL;

ALTER TABLE "User" ALTER COLUMN "loginId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_loginId_key" ON "User"("loginId");

-- ---------------------------------------------------------------------------
-- StudentParent — at most one primary contact per student (see the caveat
-- at the top of schema.prisma; this is entry 4 in that list)
-- ---------------------------------------------------------------------------

-- Deduplicate before the index below can enforce it: this failed against
-- production on first deploy — at least one student already had more than
-- one isPrimaryContact = true row, predating the index (the application
-- only ever enforced "at most one" at link-creation time, via this same
-- index, so nothing stopped an earlier code path or a direct fix from
-- leaving more than one set). Keeps the earliest-linked flagged row per
-- student and clears the rest — the same primary-else-earliest-linked
-- fallback resolvePrimaryContactParent (students.service.ts) already uses
-- at runtime, so the migration and the runtime agree on who "the primary"
-- is for any student this affects, rather than the migration picking
-- arbitrarily. "id" is a secondary sort key only to make the choice
-- deterministic if two rows for the same student share an identical
-- createdAt timestamp; it does not otherwise affect which row wins.
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
WHERE "id" IN (SELECT "id" FROM ranked_primary_contacts WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "StudentParent_one_primary_contact_per_student" ON "StudentParent" ("studentId") WHERE "isPrimaryContact";

-- ---------------------------------------------------------------------------
-- NotificationType — credential delivery
-- ---------------------------------------------------------------------------

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CREDENTIALS_ISSUED';
