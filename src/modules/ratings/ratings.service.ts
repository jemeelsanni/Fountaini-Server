import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { BulkUpsertRatingsBody, CreateTraitBody } from "./ratings.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createTrait(academicSessionId: string, input: CreateTraitBody) {
  const session = await prisma.academicSession.findUnique({ where: { id: academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  try {
    return await prisma.trait.create({ data: { ...input, academicSessionId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A trait with this name already exists in this category for this session");
    }
    throw err;
  }
}

export function listTraits(academicSessionId: string) {
  return prisma.trait.findMany({
    where: { academicSessionId },
    orderBy: [{ category: "asc" }, { order: "asc" }],
  });
}

export function listRatingScale() {
  return prisma.ratingScaleLevel.findMany({ orderBy: { value: "desc" } });
}

interface LockedResult {
  studentId: string;
  status: string;
}

/// Locks whichever of the targeted students' Results for this term already
/// exist (a student with no Result row yet simply isn't returned — ratings
/// don't require the report card compute to have run first). Mirrors
/// attendance.service.ts's lockSessionForUpdate: the guard ("only while
/// DRAFT") lives on a DIFFERENT table than the one being written (Rating),
/// so the only way to make the check-then-write genuinely race-safe against
/// a concurrent finalizeResult() is to hold a row lock on Result for the
/// whole transaction, not just read its status beforehand.
async function lockResultsForUpdate(
  tx: Prisma.TransactionClient,
  studentIds: string[],
  termId: string,
): Promise<LockedResult[]> {
  return tx.$queryRaw<LockedResult[]>`
    SELECT "studentId", "status"
    FROM "Result"
    WHERE "studentId" IN (${Prisma.join(studentIds)}) AND "termId" = ${termId}
    FOR UPDATE
  `;
}

/// Form-teacher-only bulk write of affective/psychomotor ratings for a
/// class+term, mirroring bulkUpsertScores' shape and all-or-nothing
/// rejection: any targeted student whose Result for this term is no longer
/// DRAFT (SUBMITTED or FINALIZED) rejects the WHOLE batch, re-checked at
/// write time inside the same transaction that locks those Result rows —
/// not just at this pre-check read.
export async function bulkUpsertRatings(
  classId: string,
  termId: string,
  actorUserId: string,
  input: BulkUpsertRatingsBody,
) {
  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) {
    throw AppError.notFound("Term not found");
  }

  const traitIds = [...new Set(input.entries.map((e) => e.traitId))];
  const traits = await prisma.trait.findMany({
    where: { id: { in: traitIds }, academicSessionId: term.academicSessionId },
  });
  const traitById = new Map(traits.map((t) => [t.id, t]));

  const studentIds = [...new Set(input.entries.map((e) => e.studentId))];
  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: { in: studentIds }, classId, academicSessionId: term.academicSessionId, status: "ACTIVE" },
  });
  const enrolledStudentIds = new Set(enrollments.map((e) => e.studentId));

  for (const entry of input.entries) {
    if (!traitById.has(entry.traitId)) {
      throw AppError.badRequest(`Trait ${entry.traitId} does not belong to this term's academic session`);
    }
    if (!enrolledStudentIds.has(entry.studentId)) {
      throw AppError.badRequest(`Student ${entry.studentId} is not actively enrolled in this class/session`);
    }
  }

  return prisma.$transaction(async (tx) => {
    const lockedResults = await lockResultsForUpdate(tx, studentIds, termId);
    const nonDraft = lockedResults.filter((r) => r.status !== "DRAFT");
    if (nonDraft.length > 0) {
      throw AppError.conflict(
        "One or more targeted students' results are no longer DRAFT for this term and can no longer have ratings entered",
      );
    }

    const cellKey = (studentId: string, traitId: string) => `${studentId}:${traitId}`;
    const existing = await tx.rating.findMany({
      where: {
        termId,
        OR: input.entries.map((e) => ({ studentId: e.studentId, traitId: e.traitId })),
      },
      select: { studentId: true, traitId: true },
    });
    const existingCells = new Set(existing.map((r) => cellKey(r.studentId, r.traitId)));

    const toCreate = input.entries.filter((e) => !existingCells.has(cellKey(e.studentId, e.traitId)));
    const toUpdate = input.entries.filter((e) => existingCells.has(cellKey(e.studentId, e.traitId)));

    if (toCreate.length > 0) {
      await tx.rating.createMany({
        data: toCreate.map((entry) => ({
          studentId: entry.studentId,
          termId,
          traitId: entry.traitId,
          value: entry.value,
          enteredByUserId: actorUserId,
        })),
        skipDuplicates: true,
      });
    }
    for (const entry of toUpdate) {
      await tx.rating.updateMany({
        where: { studentId: entry.studentId, termId, traitId: entry.traitId },
        data: { value: entry.value, updatedByUserId: actorUserId },
      });
    }

    return tx.rating.findMany({
      where: { termId, studentId: { in: studentIds }, traitId: { in: traitIds } },
      include: { trait: true },
    });
  });
}
