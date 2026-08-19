import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateSchoolBody, UpdateSchoolBody } from "./school.schemas.js";

/// School is a literal singleton — "never create a second School record"
/// (see the model's own comment in schema.prisma) — but nothing at the
/// database level actually enforces that (no natural unique field to hang
/// a constraint on, unlike isCurrent's partial unique indexes elsewhere in
/// this schema). createSchool() below is the one place that invariant is
/// actually upheld, the same transaction-scoped-advisory-lock pattern
/// setCurrentAcademicSession() already uses for the identical
/// read-then-conditionally-write race.
export async function getSchool() {
  const school = await prisma.school.findFirst();
  if (!school) {
    throw AppError.notFound("School has not been configured yet");
  }
  return school;
}

export async function createSchool(input: CreateSchoolBody) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('school_create'))`;
    const existing = await tx.school.findFirst();
    if (existing) {
      throw AppError.conflict("A School record already exists — use PATCH /api/school to update it");
    }
    return tx.school.create({ data: input });
  });
}

export async function updateSchool(input: UpdateSchoolBody) {
  const existing = await prisma.school.findFirst();
  if (!existing) {
    throw AppError.notFound("School has not been configured yet — create it first");
  }
  return prisma.school.update({ where: { id: existing.id }, data: input });
}
