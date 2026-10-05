-- NotificationDelivery.errorCategory: a normalized classification of why a
-- send failed, alongside the existing (now write-time-truncated) `error`
-- message — see both columns' own comments in schema.prisma and
-- categorizeProviderError in notifications.service.ts. Nullable: every
-- pre-existing row, and every delivery that never failed, has no category.
CREATE TYPE "NotificationErrorCategory" AS ENUM ('QUOTA_EXCEEDED', 'RATE_LIMITED', 'INVALID_RECIPIENT', 'PROVIDER_ERROR', 'UNKNOWN');

ALTER TABLE "NotificationDelivery" ADD COLUMN "errorCategory" "NotificationErrorCategory";
