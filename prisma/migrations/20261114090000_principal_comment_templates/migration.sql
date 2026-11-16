-- The head of school's predefined comments, picked by a report card's
-- average. Seeded with a default bank the admin can edit under Settings.

-- CreateTable
CREATE TABLE "PrincipalCommentTemplate" (
    "id" TEXT NOT NULL,
    "minAverage" DECIMAL(5,2) NOT NULL,
    "maxAverage" DECIMAL(5,2) NOT NULL,
    "comment" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrincipalCommentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrincipalCommentTemplate_minAverage_maxAverage_idx" ON "PrincipalCommentTemplate"("minAverage", "maxAverage");

-- Default bank
INSERT INTO "PrincipalCommentTemplate" ("id", "minAverage", "maxAverage", "comment", "order", "updatedAt") VALUES
  ('pct_default_excellent', 75, 100, 'An excellent result. Keep up the outstanding work.', 0, CURRENT_TIMESTAMP),
  ('pct_default_very_good', 65, 74.99, 'A very good performance. Well done — aim even higher next term.', 1, CURRENT_TIMESTAMP),
  ('pct_default_good', 50, 64.99, 'A good result with room to improve. Keep working hard.', 2, CURRENT_TIMESTAMP),
  ('pct_default_fair', 40, 49.99, 'A fair performance. More effort is needed next term.', 3, CURRENT_TIMESTAMP),
  ('pct_default_weak', 0, 39.99, 'A weak result. Needs serious improvement, with closer support at home and in school.', 4, CURRENT_TIMESTAMP);
