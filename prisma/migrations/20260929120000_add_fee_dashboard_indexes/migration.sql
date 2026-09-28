-- Two plain B-tree indexes, added for the fees dashboard/queue/reports
-- (GET /api/fees/summary, GET /api/payments, GET /api/reports/*): neither
-- FeeObligation.academicSessionId/termId nor Payment.paymentDate had any
-- supporting index before this, and every one of those routes filters on
-- them. No data migration involved — CREATE INDEX only, hand-written only
-- because this dev machine's local Postgres has migration-history drift
-- against a different branch's own migration (not because this needed
-- anything `prisma migrate dev` couldn't otherwise express).

CREATE INDEX IF NOT EXISTS "FeeObligation_academicSessionId_termId_idx" ON "FeeObligation"("academicSessionId", "termId");

CREATE INDEX IF NOT EXISTS "Payment_status_paymentDate_idx" ON "Payment"("status", "paymentDate");
