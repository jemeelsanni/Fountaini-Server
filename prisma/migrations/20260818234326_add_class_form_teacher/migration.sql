-- AlterTable
ALTER TABLE "AuditLog" ALTER COLUMN "actorRoles" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ClassFormTeacher" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "academicSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassFormTeacher_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassFormTeacher_teacherId_idx" ON "ClassFormTeacher"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "ClassFormTeacher_classId_academicSessionId_key" ON "ClassFormTeacher"("classId", "academicSessionId");

-- AddForeignKey
ALTER TABLE "ClassFormTeacher" ADD CONSTRAINT "ClassFormTeacher_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassFormTeacher" ADD CONSTRAINT "ClassFormTeacher_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassFormTeacher" ADD CONSTRAINT "ClassFormTeacher_academicSessionId_fkey" FOREIGN KEY ("academicSessionId") REFERENCES "AcademicSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
