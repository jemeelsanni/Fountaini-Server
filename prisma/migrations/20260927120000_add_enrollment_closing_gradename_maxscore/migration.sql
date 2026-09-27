-- Hand-written (not `prisma migrate dev`-generated): the SubjectResult.maxScore
-- backfill below needs a data computation Prisma's schema-diff tooling can't
-- express, so the whole migration is written directly — same reasoning as
-- add_login_id_and_identifier_counters. Every column added here is nullable
-- (no NOT NULL / backfill-then-constrain step, so no ordering hazard the way
-- that migration had), but every statement is still idempotent (IF NOT
-- EXISTS / re-runnable WHERE guards) on principle, matching this codebase's
-- established convention for hand-written migrations.

-- ---------------------------------------------------------------------------
-- Enrollment.closedAt / closedByUserId — set together when status moves off
-- ACTIVE (students.service.ts's updateStudent / bulkUpdateStudentStatus). No
-- backfill: every existing Enrollment row is either genuinely still ACTIVE
-- (closedAt correctly stays null) or stale-ACTIVE from before a student's
-- status was ever tracked (nothing has ever written a non-ACTIVE
-- EnrollmentStatus) — the first real status-changing write against a stale
-- row closes it for real, which is the correct fix, not a value this
-- migration should guess at retroactively.
-- ---------------------------------------------------------------------------

ALTER TABLE "Enrollment" ADD COLUMN IF NOT EXISTS "closedAt" TIMESTAMP(3);
ALTER TABLE "Enrollment" ADD COLUMN IF NOT EXISTS "closedByUserId" TEXT;

-- ---------------------------------------------------------------------------
-- FeeStructure.gradeName — see that column's own schema.prisma comment for
-- the classId/gradeName/school-wide targeting rules.
-- ---------------------------------------------------------------------------

ALTER TABLE "FeeStructure" ADD COLUMN IF NOT EXISTS "gradeName" TEXT;

-- ---------------------------------------------------------------------------
-- SubjectResult.maxScore — backfill from each row's own session's components
-- ---------------------------------------------------------------------------

ALTER TABLE "SubjectResult" ADD COLUMN IF NOT EXISTS "maxScore" DECIMAL(5,2);

-- Only touches rows not already backfilled (maxScore IS NULL) — safe to
-- re-run. A row whose session has zero components configured is naturally
-- excluded from component_totals (INNER JOIN + GROUP BY produce no row for
-- it), so it keeps maxScore NULL — deliberately: guessing 100 would silently
-- reproduce the exact "wrong assumed total" bug this column exists to fix,
-- just moved from the report card into the migration. This is a best-effort
-- reconstruction from CURRENT component configuration, not a perfect
-- historical replay: if components were edited after a row was originally
-- computed, the backfilled value reflects today's components, not whatever
-- was configured at the row's own original compute time — this schema has
-- no historical record of component configs to do better than that.
WITH component_totals AS (
  SELECT csa."id" AS "assignmentId", SUM(ac."maxScore") AS "total"
  FROM "ClassSubjectAssignment" csa
  JOIN "AssessmentComponent" ac ON ac."academicSessionId" = csa."academicSessionId"
  GROUP BY csa."id"
)
UPDATE "SubjectResult" sr
SET "maxScore" = ct."total"
FROM component_totals ct
WHERE sr."classSubjectAssignmentId" = ct."assignmentId"
  AND sr."maxScore" IS NULL;
