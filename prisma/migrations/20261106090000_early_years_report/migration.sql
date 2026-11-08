-- Early Years (Creche) report: a checklist trait category with section
-- headings, fill-in notes on ratings, and weight/height/areas of
-- reinforcement on the result. ALTER TYPE ... ADD VALUE is transactional as
-- of Postgres 12, and nothing here uses EARLY_YEARS, so it's safe alongside
-- the other statements.

-- AlterEnum
ALTER TYPE "TraitCategory" ADD VALUE 'EARLY_YEARS';

-- AlterTable
ALTER TABLE "Rating" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "Result" ADD COLUMN     "areasOfReinforcement" TEXT,
ADD COLUMN     "heightCm" DECIMAL(5,1),
ADD COLUMN     "weightKg" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Trait" ADD COLUMN     "section" TEXT;

