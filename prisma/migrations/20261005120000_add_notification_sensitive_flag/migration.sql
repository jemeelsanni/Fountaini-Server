-- NotificationEvent.sensitive: marks CREDENTIALS_ISSUED/PASSWORD_RESET
-- events whose persisted body is a placeholder, never the real message —
-- see the column's own comment in schema.prisma and createNotification in
-- notifications.service.ts.
--
-- Column added first, default false. Every row written from this point
-- forward by the two sensitive notification types already comes in with
-- the real secret kept out of `body` by application code (createNotification
-- builds the placeholder itself before this migration can even run) — the
-- scrub below exists only for rows that predate that change, where `body`
-- still holds the real temporary password or reset token in plaintext.
ALTER TABLE "NotificationEvent" ADD COLUMN "sensitive" BOOLEAN NOT NULL DEFAULT false;

UPDATE "NotificationEvent"
SET "body" = '[redacted — sensitive content, not stored]',
    "sensitive" = true
WHERE "type" IN ('CREDENTIALS_ISSUED', 'PASSWORD_RESET')
  AND "sensitive" = false;
