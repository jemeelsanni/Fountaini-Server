-- Soft delete for Parent — see the deletedAt field's schema comment.
ALTER TABLE "Parent" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Parent_deletedAt_idx" ON "Parent"("deletedAt");
