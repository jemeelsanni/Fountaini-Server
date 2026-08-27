import { Prisma } from "../../../generated/prisma/index.js";
import { resolveStudentAccessLevel } from "../../authorization/scopeResolvers.js";
import type { Principal } from "../../authorization/types.js";
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

  // The existing-results read and the writes it decides now happen inside
  // one transaction, and — more importantly — each write's own WHERE clause
  // re-checks status at write time, not at this read's time. Without that,
  // a finalizeResult() committing between this read and the write below
  // would go unnoticed: the plain upsert() this replaced had no way to
  // express "skip this row if it's since become FINALIZED," so it would
  // silently overwrite a finalized result's scores while leaving status
  // FINALIZED untouched — the DB refuses that now instead of app logic
  // merely trying to remember to check.
  await prisma.$transaction(async (tx) => {
    const existingResults = await tx.result.findMany({
      where: { studentId: { in: studentIds }, termId: input.termId },
      select: { studentId: true },
    });
    const existingStudentIds = new Set(existingResults.map((r) => r.studentId));

    const toCreate = computed.filter((c) => !existingStudentIds.has(c.enrollment.studentId));
    const toUpdate = computed.filter((c) => existingStudentIds.has(c.enrollment.studentId));

    if (toCreate.length > 0) {
      await tx.result.createMany({
        data: toCreate.map((c) => ({
          studentId: c.enrollment.studentId,
          enrollmentId: c.enrollment.id,
          termId: input.termId,
          status: "DRAFT" as const,
          totalScore: c.totalScore,
          averageScore: c.averageScore,
          position: positionByStudentId.get(c.enrollment.studentId) ?? null,
          outOf: c.averageScore !== null ? outOf : null,
        })),
        // Two concurrent computes racing to create the same never-before-
        // computed student's first result row — the loser's row is simply
        // dropped rather than erroring; the winner's values stand until the
        // next recompute.
        skipDuplicates: true,
      });
    }

    for (const c of toUpdate) {
      await tx.result.updateMany({
        where: { studentId: c.enrollment.studentId, termId: input.termId, status: { not: "FINALIZED" } },
        data: {
          totalScore: c.totalScore,
          averageScore: c.averageScore,
          position: positionByStudentId.get(c.enrollment.studentId) ?? null,
          outOf: c.averageScore !== null ? outOf : null,
        },
      });
    }
  });

  return prisma.result.findMany({ where: { studentId: { in: studentIds }, termId: input.termId } });
}

/// The finalized-only filter below is deliberately not an authorization
/// check: the route's requireScope(canReadStudent(...)) already decided
/// this principal may read this student's records at all. This is a
/// visibility filter on top of that — a caller whose access to this
/// specific student is RESTRICTED (PARENT or STUDENT-self; see
/// resolveStudentAccessLevel) simply doesn't have a non-finalized result in
/// their visible set, which reads as the same 404 as asking before compute
/// ever ran. FULL access (ADMIN, or a TEACHER assigned to this student's
/// class) sees every status.
export async function getResultForStudentTerm(studentId: string, termId: string, principal: Principal) {
  const result = await prisma.result.findUnique({ where: { studentId_termId: { studentId, termId } } });
  if (!result) {
    throw AppError.notFound("No result found for this student/term");
  }

  const accessLevel = await resolveStudentAccessLevel(principal, studentId);
  if (accessLevel !== "FULL" && result.status !== "FINALIZED") {
    throw AppError.notFound("No result found for this student/term");
  }

  return result;
}

/// Same finalized-only visibility rule as getResultForStudentTerm above,
/// pushed into the query's WHERE clause instead of filtered after the fact
/// — a list endpoint should just omit rows a RESTRICTED caller can't see,
/// not 404 the whole request over one non-finalized entry among others.
export async function listResultsForStudent(
  studentId: string,
  academicSessionId: string | undefined,
  principal: Principal,
) {
  const accessLevel = await resolveStudentAccessLevel(principal, studentId);

  const results = await prisma.result.findMany({
    where: {
      studentId,
      ...(academicSessionId ? { term: { academicSessionId } } : {}),
      ...(accessLevel !== "FULL" ? { status: "FINALIZED" } : {}),
    },
    include: {
      term: {
        select: {
          id: true,
          name: true,
          order: true,
          academicSession: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: [{ term: { academicSession: { startDate: "desc" } } }, { term: { order: "desc" } }],
  });

  return results.map(({ term, ...result }) => ({
    ...result,
    term: { id: term.id, name: term.name, order: term.order },
    session: term.academicSession,
  }));
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

/// Rejects with 404 (no such result) or 400 (not DRAFT) — never silently
/// writes a comment that's no longer supposed to be writable this way. The
/// `updateMany({ where: { id, status: "DRAFT" } })` + `count === 0` shape is
/// the project's standard fix for the read-then-write race documented in
/// docs/concurrency.md: without the status re-check baked into the WRITE's
/// own WHERE clause, a concurrent finalizeResult() landing between a plain
/// read and a plain write here could let a routine comment silently land on
/// an already-FINALIZED result — exactly the "backwards" bug this whole
/// feature exists to close, just moved one race window over.
async function writeDraftResultField(
  id: string,
  data: { classTeacherComment: string } | { principalComment: string },
) {
  const { count } = await prisma.result.updateMany({
    where: { id, status: "DRAFT" },
    data,
  });

  if (count === 0) {
    const result = await prisma.result.findUnique({ where: { id }, select: { id: true } });
    if (!result) {
      throw AppError.notFound("Result not found");
    }
    throw AppError.badRequest(
      "Comments can only be written directly while the result is DRAFT — once finalized, use the override endpoint",
    );
  }

  return prisma.result.findUniqueOrThrow({ where: { id } });
}

export function writeClassTeacherComment(id: string, comment: string) {
  return writeDraftResultField(id, { classTeacherComment: comment });
}

export function writePrincipalComment(id: string, comment: string) {
  return writeDraftResultField(id, { principalComment: comment });
}
