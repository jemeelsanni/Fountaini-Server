-- Separate Islamiyyah (Weekday Madrasa) results from academic ones. A class
-- now has a programme, and a student can hold one enrollment, one term
-- result, one session result and one set of ratings per programme. Every
-- existing row is ACADEMIC (the column default) — a class meant to be a
-- Madrasa group has to be recreated with programme MADRASSAH, since nothing
-- before this migration could tell the two apart.

-- CreateEnum
CREATE TYPE "Programme" AS ENUM ('ACADEMIC', 'MADRASSAH');

-- DropIndex
DROP INDEX "Enrollment_studentId_academicSessionId_key";

-- DropIndex
DROP INDEX "Rating_studentId_termId_traitId_key";

-- DropIndex
DROP INDEX "Result_studentId_termId_key";

-- DropIndex
DROP INDEX "SessionResult_studentId_academicSessionId_key";

-- AlterTable
ALTER TABLE "Class" ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

-- AlterTable
ALTER TABLE "Rating" ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

-- AlterTable
ALTER TABLE "Result" ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

-- AlterTable
ALTER TABLE "SessionResult" ADD COLUMN     "programme" "Programme" NOT NULL DEFAULT 'ACADEMIC';

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_studentId_academicSessionId_programme_key" ON "Enrollment"("studentId", "academicSessionId", "programme");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_studentId_termId_traitId_programme_key" ON "Rating"("studentId", "termId", "traitId", "programme");

-- CreateIndex
CREATE UNIQUE INDEX "Result_studentId_termId_programme_key" ON "Result"("studentId", "termId", "programme");

-- CreateIndex
CREATE UNIQUE INDEX "SessionResult_studentId_academicSessionId_programme_key" ON "SessionResult"("studentId", "academicSessionId", "programme");

