import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { CreateAssessmentComponentBody, CreateGradeBandBody } from "./grading.schemas.js";

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

export async function createGradingScale(academicSessionId: string) {
  const session = await prisma.academicSession.findUnique({ where: { id: academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }

  try {
    return await prisma.gradingScale.create({ data: { academicSessionId } });
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

export async function createGradeBand(gradingScaleId: string, input: CreateGradeBandBody) {
  const scale = await prisma.gradingScale.findUnique({ where: { id: gradingScaleId } });
  if (!scale) {
    throw AppError.notFound("Grading scale not found");
  }

  try {
    return await prisma.gradeBand.create({ data: { ...input, gradingScaleId } });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      throw AppError.conflict("A grade band with this grade label already exists on this scale");
    }
    throw err;
  }
}
