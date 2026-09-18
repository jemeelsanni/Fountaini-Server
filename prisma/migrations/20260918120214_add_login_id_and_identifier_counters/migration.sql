-- Hand-written rather than `prisma migrate dev`-generated: this migration
-- backfills existing rows (User.loginId, derived per-user from whichever
-- record is linked) before making the column NOT NULL/UNIQUE, which
-- Prisma's schema-diff tooling can't express — same reasoning as the
-- multi_role_users migration. `prisma migrate dev` also refuses to run
-- non-interactively once it detects the "unique constraint may fail on
-- existing duplicates" warning below.

-- ---------------------------------------------------------------------------
-- IdentifierCounter — race-safe admission/staff number sequences
-- ---------------------------------------------------------------------------

CREATE TABLE "IdentifierCounter" (
    "prefix" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IdentifierCounter_pkey" PRIMARY KEY ("prefix")
);

-- ---------------------------------------------------------------------------
-- User.loginId — backfill before NOT NULL/UNIQUE
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN "loginId" TEXT;
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

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

ALTER TABLE "User" ALTER COLUMN "loginId" SET NOT NULL;
CREATE UNIQUE INDEX "User_loginId_key" ON "User"("loginId");

-- ---------------------------------------------------------------------------
-- StudentParent — at most one primary contact per student (see the caveat
-- at the top of schema.prisma; this is entry 4 in that list)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "StudentParent_one_primary_contact_per_student" ON "StudentParent" ("studentId") WHERE "isPrimaryContact";

-- ---------------------------------------------------------------------------
-- NotificationType — credential delivery
-- ---------------------------------------------------------------------------

ALTER TYPE "NotificationType" ADD VALUE 'CREDENTIALS_ISSUED';
