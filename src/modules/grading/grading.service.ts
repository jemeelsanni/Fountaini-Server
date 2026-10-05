import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type {
  CreateAssessmentComponentBody,
  CreateGradeBandBody,
  CreateGradingScaleBody,
  UpdateAssessmentComponentBody,
  UpdateGradeBandBody,
} from "./grading.schemas.js";

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function createAssessmentComponent(
  academicSessionId: string,
  input: CreateAssessmentComponentBody,
) {
  const session = await prisma.academicSession.findUnique({ where: { id: academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  try {
    return await prisma.assessmentComponent.create({ data: { ...input, academicSessionId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("An assessment component with this code already exists for this session");
    }
    throw err;
  }
}

export function listAssessmentComponents(academicSessionId: string) {
  return prisma.assessmentComponent.findMany({
    where: { academicSessionId },
    orderBy: { order: "asc" },
  });
}

/// A warning, not a reject, when the edit leaves the session's components
/// summing to something other than 100. scores.service.ts's submitScores
/// sums raw scores across every component unconditionally and compares
/// that sum straight against grade bands calibrated for 0-100 — nothing
/// normalizes it, so a non-100 total silently produces an out-of-scale
/// grade with no error anywhere in that path. Rejecting outright was the
/// other option, but this invariant isn't enforced at creation time either
/// (components are created one at a time, each independently), so a hard
/// block only here would be a partial, surprising guarantee; it would also
/// block a legitimate multi-step rebalance (e.g. moving weight from CA to
/// EXAM across two separate PATCH calls), which necessarily leaves the sum
/// temporarily off between the two. A warning surfaces the same problem
/// without blocking that workflow.
export async function updateAssessmentComponent(id: string, input: UpdateAssessmentComponentBody) {
  const component = await prisma.assessmentComponent.findUnique({ where: { id } });
  if (!component) {
    throw AppError.notFound("Assessment component not found");
  }

  let updated;
  try {
    updated = await prisma.assessmentComponent.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("An assessment component with this code already exists for this session");
    }
    throw err;
  }

  if (input.maxScore === undefined) {
    return updated;
  }

  const siblings = await prisma.assessmentComponent.findMany({
    where: { academicSessionId: component.academicSessionId },
  });
  const total = siblings.reduce((sum, c) => sum + c.maxScore.toNumber(), 0);
  if (total !== 100) {
    return {
      ...updated,
      warning:
        `This academic session's assessment components now sum to ${total}, not 100 — scores computed ` +
        "against them will not be on a 0-100 scale until this is corrected.",
    };
  }
  return updated;
}

/// 409 rather than a cascade: unlike ClassSubjectAssignment's timetable
/// entries, a Score is a teacher's recorded work — never silently deleted
/// alongside the component that defined it.
///
/// Editing or deleting a component after results have already been
/// computed from it leaves those results stale until someone recomputes —
/// see the route description for why this can leave a class with some
/// report cards built from old components and some from new.
export async function deleteAssessmentComponent(id: string) {
  const component = await prisma.assessmentComponent.findUnique({ where: { id } });
  if (!component) {
    throw AppError.notFound("Assessment component not found");
  }
  const scoreCount = await prisma.score.count({ where: { assessmentComponentId: id } });
  if (scoreCount > 0) {
    throw AppError.conflict(
      `This component has ${scoreCount} recorded score${scoreCount === 1 ? "" : "s"} — ` +
        "remove them before deleting it.",
    );
  }
  await prisma.assessmentComponent.delete({ where: { id } });
}

export async function createGradingScale(academicSessionId: string, input: CreateGradingScaleBody) {
  const session = await prisma.academicSession.findUnique({ where: { id: academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  try {
    return await prisma.gradingScale.create({
      data: { academicSessionId, sessionAverageMethod: input.sessionAverageMethod },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A grading scale already exists for this session");
    }
    throw err;
  }
}

export async function getGradingScaleForSession(academicSessionId: string) {
  const scale = await prisma.gradingScale.findUnique({
    where: { academicSessionId },
    include: { bands: { orderBy: { minScore: "desc" } } },
  });
  if (!scale) {
    throw AppError.notFound("No grading scale defined for this session");
  }
  return scale;
}

/// Ranges are treated as inclusive on both ends, matching submitScores'
/// own lookup (`>= minScore && <= maxScore`) — two bands overlap unless one
/// lies entirely below the other. Checked on both create and update: a band
/// created overlapping an existing one is the same bug as one edited into
/// overlap, so both paths call this. This is a plain read-then-check, not
/// lock-protected like setCurrentAcademicSession's advisory lock for a
/// similar single-admin-operation invariant — two admins racing to create
/// overlapping bands at the same instant could both pass the check, but
/// grade bands are a rarely-and-carefully edited setup step, not a
/// high-concurrency path, so that gap is accepted rather than engineered
/// around.
/// Exported for admin.service.ts's setup-status check, which needs the
/// same pairwise overlap test applied read-only across a whole scale's
/// bands — see that file for why a defensive, read-only recheck is worth
/// having even though assertNoOverlappingBand below already prevents an
/// overlap from being written in the first place.
export function bandsOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return aMin <= bMax && aMax >= bMin;
}

async function assertNoOverlappingBand(
  gradingScaleId: string,
  minScore: number,
  maxScore: number,
  excludeBandId?: string,
): Promise<void> {
  const siblings = await prisma.gradeBand.findMany({
    where: { gradingScaleId, ...(excludeBandId ? { id: { not: excludeBandId } } : {}) },
  });
  const overlapping = siblings.find((b) =>
    bandsOverlap(minScore, maxScore, b.minScore.toNumber(), b.maxScore.toNumber()),
  );
  if (overlapping) {
    throw AppError.badRequest(
      `This range (${minScore}-${maxScore}) overlaps the existing "${overlapping.grade}" band ` +
        `(${overlapping.minScore.toNumber()}-${overlapping.maxScore.toNumber()})`,
    );
  }
}

// GradeBand.minScore/maxScore are Decimal(5,2) — the finest increment the
// column can hold is 0.01, so working in hundredths (plain integers) avoids
// float-rounding false positives/negatives that plain decimal arithmetic
// (0.1 + 0.2 !== 0.3) could otherwise introduce.
const HUNDREDTHS_PER_UNIT = 100;
const GRADE_RANGE_MIN = 0;
const GRADE_RANGE_MAX = 100;

function toHundredths(n: number): number {
  return Math.round(n * HUNDREDTHS_PER_UNIT);
}

function fromHundredths(n: number): number {
  return n / HUNDREDTHS_PER_UNIT;
}

/// Gaps between bands (e.g. 0-39 and 50-100, leaving 40-49 ungraded) over the
/// scale's full 0-100 range — including a leading gap (nothing covers 0-49)
/// or trailing gap (nothing covers 80-100), the same failure mode as a
/// middle gap. Two bands are "contiguous," not gapped, when one's maxScore
/// sits exactly one hundredth below the next's minScore — the established
/// convention already used elsewhere in this codebase (see e.g.
/// scores.test.ts's own 0-49.99/50-69.99/70-100 bands) — so this only
/// flags a gap wider than that single-hundredth step.
/// Exported for admin.service.ts's setup-status check — see that file for
/// how it's reused there rather than reimplemented.
export function findCoverageGaps(
  bands: Array<{ minScore: number; maxScore: number }>,
): Array<{ from: number; to: number }> {
  const sorted = [...bands]
    .map((b) => ({ min: toHundredths(b.minScore), max: toHundredths(b.maxScore) }))
    .sort((a, b) => a.min - b.min);

  const gaps: Array<{ from: number; to: number }> = [];
  let coveredThrough = toHundredths(GRADE_RANGE_MIN) - 1; // nothing covered yet
  for (const band of sorted) {
    if (band.min > coveredThrough + 1) {
      gaps.push({ from: fromHundredths(coveredThrough + 1), to: fromHundredths(band.min - 1) });
    }
    coveredThrough = Math.max(coveredThrough, band.max);
  }
  const upperBound = toHundredths(GRADE_RANGE_MAX);
  if (coveredThrough < upperBound - 1) {
    gaps.push({ from: fromHundredths(coveredThrough + 1), to: fromHundredths(upperBound) });
  }
  return gaps;
}

/// A warning, not a rejection — same reasoning, and the same reason it
/// can't be blocked per-band, as updateAssessmentComponent's non-100-total
/// warning: submitScores' band lookup (`bands.find(...)`) already handles a
/// score that matches no band gracefully, storing `grade: null` rather than
/// throwing, on a real, already-computed report card — a silent failure of
/// the same class as a non-100 component total, just surfacing on a
/// different field. Called after every create/update, mirroring
/// assertNoOverlappingBand's own both-directions coverage: a scale built up
/// one band at a time will genuinely have gaps until the admin finishes
/// configuring it, so this can't be a hard reject without blocking that
/// ordinary, incremental workflow.
async function buildGapWarning(gradingScaleId: string): Promise<string | undefined> {
  const bands = await prisma.gradeBand.findMany({ where: { gradingScaleId } });
  const gaps = findCoverageGaps(bands.map((b) => ({ minScore: b.minScore.toNumber(), maxScore: b.maxScore.toNumber() })));
  if (gaps.length === 0) {
    return undefined;
  }
  const ranges = gaps.map((g) => `${g.from}-${g.to}`).join(", ");
  return (
    `This grading scale doesn't cover ${ranges} — a score landing in ${gaps.length === 1 ? "that range" : "one of those ranges"} ` +
    "will grade as null on a report card."
  );
}

export async function createGradeBand(gradingScaleId: string, input: CreateGradeBandBody) {
  const scale = await prisma.gradingScale.findUnique({ where: { id: gradingScaleId } });
  if (!scale) {
    throw AppError.notFound("Grading scale not found");
  }

  await assertNoOverlappingBand(gradingScaleId, input.minScore, input.maxScore);

  let created;
  try {
    created = await prisma.gradeBand.create({ data: { ...input, gradingScaleId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A grade band with this grade label already exists on this scale");
    }
    throw err;
  }

  const warning = await buildGapWarning(gradingScaleId);
  return warning ? { ...created, warning } : created;
}

export async function updateGradeBand(id: string, input: UpdateGradeBandBody) {
  const band = await prisma.gradeBand.findUnique({ where: { id } });
  if (!band) {
    throw AppError.notFound("Grade band not found");
  }

  const mergedMin = input.minScore ?? band.minScore.toNumber();
  const mergedMax = input.maxScore ?? band.maxScore.toNumber();
  if (mergedMax <= mergedMin) {
    throw AppError.badRequest("maxScore must be greater than minScore");
  }

  if (input.minScore !== undefined || input.maxScore !== undefined) {
    await assertNoOverlappingBand(band.gradingScaleId, mergedMin, mergedMax, id);
  }

  let updated;
  try {
    updated = await prisma.gradeBand.update({ where: { id }, data: input });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A grade band with this grade label already exists on this scale");
    }
    throw err;
  }

  const warning = await buildGapWarning(band.gradingScaleId);
  return warning ? { ...updated, warning } : updated;
}

export async function deleteGradeBand(id: string) {
  // deleteMany + count rather than findUnique-then-delete: same concurrent
  // double-delete reasoning as deleteClassFormTeacher/unlinkChild — no FK
  // gap here since nothing references GradeBand (only GradeBand ->
  // GradingScale, onDelete: Cascade, runs the other direction).
  const { count } = await prisma.gradeBand.deleteMany({ where: { id } });
  if (count === 0) {
    throw AppError.notFound("Grade band not found");
  }
}
