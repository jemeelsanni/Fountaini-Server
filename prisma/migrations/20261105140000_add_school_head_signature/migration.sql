-- The head of school's signature for report cards, as a data URL (no file
-- storage in this backend). Size and type are validated in the service.
ALTER TABLE "School" ADD COLUMN "headSignature" TEXT;
