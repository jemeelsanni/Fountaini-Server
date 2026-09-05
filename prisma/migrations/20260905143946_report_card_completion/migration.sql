-- CreateEnum
CREATE TYPE "SessionAverageMethod" AS ENUM ('SESSION_AVERAGE', 'FINAL_TERM_CARRIES');

-- CreateEnum
CREATE TYPE "TraitCategory" AS ENUM ('AFFECTIVE', 'PSYCHOMOTOR');

-- AlterTable
ALTER TABLE "GradingScale" ADD COLUMN     "sessionAverageMethod" "SessionAverageMethod" NOT NULL DEFAULT 'SESSION_AVERAGE';

-- AlterTable
ALTER TABLE "Result" ADD COLUMN     "daysPresent" INTEGER,
ADD COLUMN     "daysSchoolOpened" INTEGER,
ADD COLUMN     "feeWithholdingReleased" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Trait" (
    "id" TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "category" "TraitCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trait_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatingScaleLevel" (
    "value" INTEGER NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "RatingScaleLevel_pkey" PRIMARY KEY ("value")
);

-- CreateTable
CREATE TABLE "Rating" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "termId" TEXT NOT NULL,
    "traitId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "enteredByUserId" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionSubjectAverage" (
    "id" TEXT NOT NULL,
    "sessionResultId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "averageScore" DECIMAL(5,2) NOT NULL,
    "termsCounted" INTEGER NOT NULL,

    CONSTRAINT "SessionSubjectAverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Trait_academicSessionId_category_name_key" ON "Trait"("academicSessionId", "category", "name");

-- CreateIndex
CREATE INDEX "Rating_termId_traitId_idx" ON "Rating"("termId", "traitId");

-- CreateIndex
CREATE UNIQUE INDEX "Rating_studentId_termId_traitId_key" ON "Rating"("studentId", "termId", "traitId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionSubjectAverage_sessionResultId_subjectId_key" ON "SessionSubjectAverage"("sessionResultId", "subjectId");

-- AddForeignKey
ALTER TABLE "Trait" ADD CONSTRAINT "Trait_academicSessionId_fkey" FOREIGN KEY ("academicSessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_termId_fkey" FOREIGN KEY ("termId") REFERENCES "Term"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rating" ADD CONSTRAINT "Rating_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "Trait"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSubjectAverage" ADD CONSTRAINT "SessionSubjectAverage_sessionResultId_fkey" FOREIGN KEY ("sessionResultId") REFERENCES "SessionResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionSubjectAverage" ADD CONSTRAINT "SessionSubjectAverage_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
