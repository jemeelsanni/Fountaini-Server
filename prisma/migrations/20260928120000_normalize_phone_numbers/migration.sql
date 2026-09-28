-- Normalises every existing phone number (User.phone, Parent.phone,
-- Parent.alternatePhone, School.contactPhone, AdmissionEnquiry.parentPhone)
-- to E.164, matching the same structural rule the app now enforces at the
-- boundary (src/lib/phone.ts's normalizeNigerianPhone — kept in sync by
-- hand, not generated from this SQL): an 11-digit string starting "0", a
-- 13-digit string starting "234", or "+234" followed by 10 digits, once
-- spaces/dashes/brackets/dots are stripped. Anything else can't be
-- normalised and is set to NULL (reported via RAISE NOTICE before it's
-- overwritten, since there's no other reporting channel available to a
-- raw-SQL migration).
--
-- User.phone is @unique, so normalisation can turn two previously-distinct
-- values (08012345678 and +2348012345678) into the same one — the same
-- class of failure as migration 20260918120214's StudentParent primary-
-- contact index, which failed against production on first deploy for
-- exactly this reason (a unique index enforcing something a normalisation/
-- dedup step hadn't accounted for yet). Applying that migration's own
-- lesson rather than repeating the incident: this migration self-heals
-- deterministically instead of failing and waiting on a human. On a
-- collision, the earliest-created row (tie-broken by id, same convention
-- as 20260918120214) keeps the normalised number; every later row involved
-- in that collision is set to NULL and reported. In this codebase's actual
-- current state this is theoretical, not remedial — User.phone has no
-- write path anywhere in the application (see docs/concurrency.md's phone-
-- number audit findings; nothing sets it, so no production row has a
-- non-NULL value to collide) — but the migration is written to be correct
-- regardless of that, since it's cheap to get right now and expensive to
-- discover it's wrong later.
--
-- AdmissionEnquiry.parentPhone is NOT NULL, unlike the other four columns:
-- an existing row that can't be normalised is left at its original,
-- un-normalised value (there's nowhere else for it to go without violating
-- the column's own NOT NULL constraint, and blanking a required contact
-- field would make the row less useful, not more) — still reported, so the
-- gap is visible rather than silent.

-- ---------------------------------------------------------------------------
-- Normalisation function — temporary, dropped at the end of this file. Only
-- needed for this one-time backfill; every future write goes through
-- src/lib/phone.ts's Zod transform instead, so this has no reason to
-- outlive the migration that uses it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.normalize_ng_phone(input TEXT) RETURNS TEXT AS $$
DECLARE
  stripped TEXT;
BEGIN
  IF input IS NULL THEN
    RETURN NULL;
  END IF;
  stripped := regexp_replace(input, '[\s\-().]', '', 'g');
  IF stripped ~ '^0\d{10}$' THEN
    RETURN '+234' || substring(stripped FROM 2);
  ELSIF stripped ~ '^234\d{10}$' THEN
    RETURN '+' || stripped;
  ELSIF stripped ~ '^\+234\d{10}$' THEN
    RETURN stripped;
  ELSE
    RETURN NULL;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------------------------------------------------------------------------
-- User.phone — collision-aware (unique column)
-- ---------------------------------------------------------------------------

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, phone FROM "User"
    WHERE phone IS NOT NULL AND pg_temp.normalize_ng_phone(phone) IS NULL
  LOOP
    RAISE NOTICE 'User.phone unnormalisable, set to NULL: id=%, value=%', r.id, r.phone;
  END LOOP;

  FOR r IN
    SELECT id, phone, rn FROM (
      SELECT id, phone,
             ROW_NUMBER() OVER (
               PARTITION BY pg_temp.normalize_ng_phone(phone)
               ORDER BY "createdAt" ASC, id ASC
             ) AS rn
      FROM "User"
      WHERE phone IS NOT NULL AND pg_temp.normalize_ng_phone(phone) IS NOT NULL
    ) ranked
    WHERE rn > 1
  LOOP
    RAISE NOTICE 'User.phone collision after normalisation, set to NULL (not the earliest-created row): id=%, value=%, normalised=%',
      r.id, r.phone, pg_temp.normalize_ng_phone(r.phone);
  END LOOP;
END $$;

-- Capture the plan (who ends up with what) from the ORIGINAL data before
-- touching the table at all. Two phases are required, not one: Postgres
-- checks a non-deferred unique constraint per row as an UPDATE applies it,
-- not once at the end of the statement — so setting the winning row of a
-- collision to its candidate value in the same pass as nulling the losers
-- can still hit "duplicate key" if the losing row (still holding its old,
-- already-normalised-shaped value) hasn't been processed yet. Verified
-- directly: a single-statement CASE-driven UPDATE equivalent to this
-- actually throws duplicate key value violates unique constraint
-- "User_phone_key" against exactly this scenario. Splitting into "null
-- every row in the plan" then "restore only the winners" avoids ever
-- having two rows hold the same phone at once. Both phases run inside
-- this migration's own transaction, so the intermediate all-NULL state
-- is never visible outside it.
CREATE TEMP TABLE phone_migration_plan AS
SELECT id,
       pg_temp.normalize_ng_phone(phone) AS candidate,
       ROW_NUMBER() OVER (
         PARTITION BY pg_temp.normalize_ng_phone(phone)
         ORDER BY "createdAt" ASC, id ASC
       ) AS rn
FROM "User"
WHERE phone IS NOT NULL AND pg_temp.normalize_ng_phone(phone) IS NOT NULL;

UPDATE "User" u SET phone = NULL FROM phone_migration_plan p WHERE u.id = p.id;
UPDATE "User" u SET phone = p.candidate FROM phone_migration_plan p WHERE u.id = p.id AND p.rn = 1;

DROP TABLE phone_migration_plan;

UPDATE "User"
SET phone = NULL
WHERE phone IS NOT NULL AND pg_temp.normalize_ng_phone(phone) IS NULL;

-- ---------------------------------------------------------------------------
-- Parent.phone / Parent.alternatePhone — no unique constraint, no collision risk
-- ---------------------------------------------------------------------------

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, phone FROM "Parent"
    WHERE phone IS NOT NULL AND pg_temp.normalize_ng_phone(phone) IS NULL
  LOOP
    RAISE NOTICE 'Parent.phone unnormalisable, set to NULL: id=%, value=%', r.id, r.phone;
  END LOOP;

  FOR r IN
    SELECT id, "alternatePhone" FROM "Parent"
    WHERE "alternatePhone" IS NOT NULL AND pg_temp.normalize_ng_phone("alternatePhone") IS NULL
  LOOP
    RAISE NOTICE 'Parent.alternatePhone unnormalisable, set to NULL: id=%, value=%', r.id, r."alternatePhone";
  END LOOP;
END $$;

UPDATE "Parent" SET phone = pg_temp.normalize_ng_phone(phone) WHERE phone IS NOT NULL;
UPDATE "Parent" SET "alternatePhone" = pg_temp.normalize_ng_phone("alternatePhone") WHERE "alternatePhone" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- School.contactPhone — singleton row, no collision risk
-- ---------------------------------------------------------------------------

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, "contactPhone" FROM "School"
    WHERE "contactPhone" IS NOT NULL AND pg_temp.normalize_ng_phone("contactPhone") IS NULL
  LOOP
    RAISE NOTICE 'School.contactPhone unnormalisable, set to NULL: id=%, value=%', r.id, r."contactPhone";
  END LOOP;
END $$;

UPDATE "School" SET "contactPhone" = pg_temp.normalize_ng_phone("contactPhone") WHERE "contactPhone" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- AdmissionEnquiry.parentPhone — NOT NULL, so an unnormalisable value is
-- reported but left as-is rather than nulled (see file header).
-- ---------------------------------------------------------------------------

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT id, "parentPhone" FROM "AdmissionEnquiry"
    WHERE pg_temp.normalize_ng_phone("parentPhone") IS NULL
  LOOP
    RAISE NOTICE 'AdmissionEnquiry.parentPhone unnormalisable, left unchanged (column is NOT NULL): id=%, value=%', r.id, r."parentPhone";
  END LOOP;
END $$;

UPDATE "AdmissionEnquiry"
SET "parentPhone" = pg_temp.normalize_ng_phone("parentPhone")
WHERE pg_temp.normalize_ng_phone("parentPhone") IS NOT NULL;

DROP FUNCTION pg_temp.normalize_ng_phone(TEXT);
