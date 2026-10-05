-- Normalizes existing User.email (trim + lowercase) and, for parent/bare
-- accounts only — no linked Staff or Student, the set where loginId
-- mirrors email (see User.loginId's own schema comment) — loginId too.
-- Student/Staff loginId (admission/staff number) is untouched; it has
-- nothing to do with email case. Going forward, normalizeEmail()
-- (src/modules/auth/loginIdentifier.ts) keeps every new/changed row
-- canonical at write time — this migration only cleans up what predates
-- that function existing.
--
-- Self-heals a genuine case-collision BEFORE normalizing, the same
-- "dedup before enforcing" pattern already used elsewhere in this schema
-- (see the caveat at the top of this file): if two existing rows would
-- normalize to the SAME value (e.g. "Foo@Bar.com" and "foo@bar.com", both
-- legal under the old case-sensitive uniqueness), the earliest-created row
-- is normalized and the other is left exactly as it was. Unlike the
-- bankReference/primary-contact self-heals, the "loser" here is NOT
-- modified at all: nulling or renaming someone's login email could lock
-- them out or misdirect their credentials, and a case-collision like this
-- almost certainly means two accounts for the same person — a real,
-- pre-existing data problem worth a human actually looking at it, not a
-- migration silently guessing which one to keep.
WITH ranked_emails AS (
  SELECT
    "id",
    LOWER(TRIM("email")) AS "normalizedEmail",
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM("email"))
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "User"
  WHERE "email" IS NOT NULL
)
UPDATE "User" u
SET "email" = r."normalizedEmail"
FROM ranked_emails r
WHERE u."id" = r."id" AND r.rn = 1 AND u."email" != r."normalizedEmail";

WITH ranked_login_ids AS (
  SELECT
    u."id",
    LOWER(TRIM(u."loginId")) AS "normalizedLoginId",
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(u."loginId"))
      ORDER BY u."createdAt" ASC, u."id" ASC
    ) AS rn
  FROM "User" u
  WHERE NOT EXISTS (SELECT 1 FROM "Staff" s WHERE s."userId" = u."id")
    AND NOT EXISTS (SELECT 1 FROM "Student" st WHERE st."userId" = u."id")
)
UPDATE "User" u
SET "loginId" = r."normalizedLoginId"
FROM ranked_login_ids r
WHERE u."id" = r."id" AND r.rn = 1 AND u."loginId" != r."normalizedLoginId";
