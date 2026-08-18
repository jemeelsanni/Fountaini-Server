-- Hand-written rather than `prisma migrate dev`-generated: this migration
-- moves data (existing User.role values into UserRole rows, existing
-- AuditLog.actorRole values into AuditLog.actorRoles arrays), which Prisma's
-- schema-diff tooling can't express — same reasoning as every other
-- hand-written migration in this project (see the partial-unique-index
-- ones). Also, `prisma migrate dev` refuses to run non-interactively once it
-- detects the column-drop-with-existing-data warning below.

-- ---------------------------------------------------------------------------
-- User.role (scalar) -> UserRole (one row per role a user holds)
-- ---------------------------------------------------------------------------

CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "role")
);

CREATE INDEX "UserRole_role_idx" ON "UserRole"("role");

ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every existing user's single role becomes their first (and so far only)
-- UserRole row. No user loses a role they had.
INSERT INTO "UserRole" ("userId", "role")
SELECT "id", "role" FROM "User";

DROP INDEX "User_role_idx";
ALTER TABLE "User" DROP COLUMN "role";

-- ---------------------------------------------------------------------------
-- AuditLog.actorRole (scalar, nullable) -> AuditLog.actorRoles (array)
-- ---------------------------------------------------------------------------

ALTER TABLE "AuditLog" ADD COLUMN "actorRoles" "Role"[] NOT NULL DEFAULT ARRAY[]::"Role"[];

-- Preserve existing audit history: a recorded single role becomes a
-- single-element array; rows that never recorded a role (actorRole IS NULL,
-- e.g. system-initiated entries) get the column's empty-array default.
UPDATE "AuditLog" SET "actorRoles" = ARRAY["actorRole"] WHERE "actorRole" IS NOT NULL;

ALTER TABLE "AuditLog" DROP COLUMN "actorRole";
