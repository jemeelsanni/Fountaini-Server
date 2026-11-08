-- Fee structures can target a programme (ACADEMIC/MADRASSAH), new vs returning
-- students, and a gender. Existing rows become ACADEMIC / ALL / null — exactly
-- what generateObligations already billed, so nothing changes for them.

-- CreateEnum
CREATE TYPE "FeeAudience" AS ENUM ('ALL', 'NEW_STUDENTS', 'RETURNING_STUDENTS');

-- AlterTable
ALTER TABLE "FeeStructure" ADD COLUMN     "audience" "FeeAudience" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

