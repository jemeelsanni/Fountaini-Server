import { Prisma } from "../../../generated/prisma/index.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { ComputeResultsBody, OverrideResultBody } from "./results.schemas.js";

/// Computes/refreshes DRAFT Results for every actively-enrolled student in a
/// class for a term, from whatever SubjectResults have been submitted so far
/// (partial subjects allowed — see decision log). Ranking (position/outOf) is
/// only assigned among students who have at least one submitted subject.
/// Already-FINALIZED results are never touched by a recompute — they're
/// immutable except via overrideResult().
export async function computeResultsForClass(input: ComputeResultsBody) {
  const term = await prisma.term.findUnique({ where: { id: input.termId } });
  if (!term) {
    throw AppError.notFound("Term not found");
  }

  const klass = await prisma.class.findUnique({ where: { id: input.classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }

  const enrollments = await prisma.enrollment.findMany({
    where: { classId: input.classId, academicSessionId: term.academicSessionId, status: "ACTIVE" },
  });
  if (enrollments.length === 0) {
    throw AppError.badRequest("No students are actively enrolled in this class for this session");
  }

  const assignments = await prisma.classSubjectAssignment.findMany({
    where: { classId: input.classId, academicSessionId: term.academicSessionId },
  });
  const assignmentIds = assignments.map((a) => a.id);
  const studentIds = enrollments.map((e) => e.studentId);

  const subjectResults = await prisma.subjectResult.findMany({
    where: {
      classSubjectAssignmentId: { in: assignmentIds },
      termId: input.termId,
      studentId: { in: studentIds },
      status: "SUBMITTED",
    },
  });

  const byStudent = new Map<string, typeof subjectResults>();
  for (const sr of subjectResults) {
    const list = byStudent.get(sr.studentId) ?? [];
    list.push(sr);
    byStudent.set(sr.studentId, list);
  }

  const computed = enrollments.map((enrollment) => {
    const studentSubjectResults = byStudent.get(enrollment.studentId) ?? [];
    const totalScore = studentSubjectResults.reduce((sum, sr) => sum + sr.totalScore.toNumber(), 0);
    const averageScore = studentSubjectResults.length > 0 ? totalScore / studentSubjectResults.length : null;
    return { enrollment, totalScore, averageScore };
  });

  const ranked = computed
    .filter((c): c is typeof c & { averageScore: number } => c.averageScore !== null)
    .sort((a, b) => b.averageScore - a.averageScore);
  const outOf = ranked.length;
  const positionByStudentId = new Map(ranked.map((c, index) => [c.enrollment.studentId, index + 1]));

  const existingResults = await prisma.result.findMany({
    where: { studentId: { in: studentIds }, termId: input.termId },
  });
  const finalizedStudentIds = new Set(
    existingResults.filter((r) => r.status === "FINALIZED").map((r) => r.studentId),
  );

  const toUpsert = computed.filter((c) => !finalizedStudentIds.has(c.enrollment.studentId));

  await prisma.$transaction(
    toUpsert.map((c) =>
      prisma.result.upsert({
        where: { studentId_termId: { studentId: c.enrollment.studentId, termId: input.termId } },
        create: {
          studentId: c.enrollment.studentId,
          enrollmentId: c.enrollment.id,
          termId: input.termId,
          status: "DRAFT",
          totalScore: c.totalScore,
          averageScore: c.averageScore,
          position: positionByStudentId.get(c.enrollment.studentId) ?? null,
          outOf: c.averageScore !== null ? outOf : null,
        },
        update: {
          totalScore: c.totalScore,
          averageScore: c.averageScore,
          position: positionByStudentId.get(c.enrollment.studentId) ?? null,
          outOf: c.averageScore !== null ? outOf : null,
        },
      }),
    ),
  );

  return prisma.result.findMany({ where: { studentId: { in: studentIds }, termId: input.termId } });
}

export async function getResultForStudentTerm(studentId: string, termId: string) {
  const result = await prisma.result.findUnique({ where: { studentId_termId: { studentId, termId } } });
  if (!result) {
    throw AppError.notFound("No result found for this student/term");
  }
  return result;
}

export function listResultsForClass(classId: string, termId: string) {
  return prisma.result.findMany({
    where: { termId, enrollment: { classId } },
    include: { student: true },
    orderBy: [{ position: "asc" }],
  });
}

export async function finalizeResult(id: string, actorUserId: string) {
  const result = await prisma.result.findUnique({ where: { id } });
  if (!result) {
    throw AppError.notFound("Result not found");
  }
  if (result.status === "FINALIZED") {
    throw AppError.conflict("This result is already finalized");
  }

  return prisma.result.update({
    where: { id },
    data: { status: "FINALIZED", finalizedByUserId: actorUserId, finalizedAt: new Date() },
  });
}

export async function overrideResult(id: string, actorUserId: string, input: OverrideResultBody) {
  const result = await prisma.result.findUnique({ where: { id } });
  if (!result) {
    throw AppError.notFound("Result not found");
  }
  if (result.status !== "FINALIZED") {
    throw AppError.badRequest("Only finalized results can be overridden");
  }

  return prisma.$transaction(async (tx) => {
    let oldValue: Prisma.JsonNullValueInput | Prisma.InputJsonValue;
    let updated;

    switch (input.fieldName) {
      case "totalScore":
        oldValue = result.totalScore ? result.totalScore.toNumber() : Prisma.JsonNull;
        updated = await tx.result.update({ where: { id }, data: { totalScore: Number(input.newValue) } });
        break;
      case "averageScore":
        oldValue = result.averageScore ? result.averageScore.toNumber() : Prisma.JsonNull;
        updated = await tx.result.update({ where: { id }, data: { averageScore: Number(input.newValue) } });
        break;
      case "position":
        oldValue = result.position ?? Prisma.JsonNull;
        updated = await tx.result.update({ where: { id }, data: { position: Number(input.newValue) } });
        break;
      case "outOf":
        oldValue = result.outOf ?? Prisma.JsonNull;
        updated = await tx.result.update({ where: { id }, data: { outOf: Number(input.newValue) } });
        break;
      case "classTeacherComment":
        oldValue = result.classTeacherComment ?? Prisma.JsonNull;
        updated = await tx.result.update({
          where: { id },
          data: { classTeacherComment: input.newValue },
        });
        break;
      case "principalComment":
        oldValue = result.principalComment ?? Prisma.JsonNull;
        updated = await tx.result.update({ where: { id }, data: { principalComment: input.newValue } });
        break;
    }

    await tx.resultOverride.create({
      data: {
        targetType: "RESULT",
        resultId: id,
        fieldName: input.fieldName,
        oldValue,
        newValue: input.newValue,
        reason: input.reason,
        performedByUserId: actorUserId,
      },
    });

    return updated;
  });
}
