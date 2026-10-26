-- Soft delete for Student — see the deletedAt field's schema comment.
ALTER TABLE "Student" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "Student_deletedAt_idx" ON "Student"("deletedAt");
