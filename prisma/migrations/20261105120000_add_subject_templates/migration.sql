-- Subject templates: a named, ordered subject list the admin frontend applies
-- to a class. Name uniqueness is case-insensitive via a unique index on
-- lower("name") — Prisma's schema DSL can't express an expression index (see
-- the caveat at the top of schema.prisma), so it's declared here only.

-- CreateTable
CREATE TABLE "SubjectTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubjectTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubjectTemplateSubject" (
    "templateId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL,

    CONSTRAINT "SubjectTemplateSubject_pkey" PRIMARY KEY ("templateId","subjectId")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubjectTemplate_name_lower_key" ON "SubjectTemplate" (lower("name"));

-- CreateIndex
CREATE INDEX "SubjectTemplateSubject_subjectId_idx" ON "SubjectTemplateSubject"("subjectId");

-- AddForeignKey
ALTER TABLE "SubjectTemplateSubject" ADD CONSTRAINT "SubjectTemplateSubject_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SubjectTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubjectTemplateSubject" ADD CONSTRAINT "SubjectTemplateSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
