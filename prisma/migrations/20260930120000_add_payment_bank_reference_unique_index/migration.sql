-- Payment.bankReference: at most one non-REJECTED row per reference value.
-- A real bank reference identifies one transfer, so the same reference
-- logged twice against a non-rejected claim is a genuine duplicate, not a
-- coincidence to allow.
--
-- Self-heals before creating the index, following this schema's own
-- established lesson (see the caveat at the top of this file, and
-- migration 20260918120214's own history: that one failed against
-- production on first deploy because nothing had stopped duplicates from
-- accumulating before its index existed) rather than risk the same
-- failure here. No duplicate bankReference is expected to exist yet — this
-- is a brand-new field with no history of being deduplicated — but paying
-- the small cost of handling it deterministically now is cheaper than
-- discovering the gap on a failed deploy later. Keeps the earliest-created
-- row's reference (tie-broken by id, same convention as every other
-- self-heal in this schema) and nulls the reference on every later
-- duplicate — never deletes or rejects the payment itself, only the
-- reference value, so a bursar reviewing it can ask the parent to confirm
-- which transfer it actually was.
WITH ranked_references AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "bankReference"
           ORDER BY "createdAt" ASC, "id" ASC
         ) AS rn
  FROM "Payment"
  WHERE "bankReference" IS NOT NULL AND "status" != 'REJECTED'
)
UPDATE "Payment"
SET "bankReference" = NULL
WHERE "id" IN (SELECT "id" FROM ranked_references WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS "Payment_bankReference_unique_when_not_rejected"
  ON "Payment"("bankReference")
  WHERE "bankReference" IS NOT NULL AND "status" != 'REJECTED';
