import { Prisma, type SessionAverageMethod } from "../../../generated/prisma/index.js";
import { resolveStudentAccessLevel } from "../../authorization/scopeResolvers.js";
import type { Principal } from "../../authorization/types.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { withBalance } from "../fees/fees.service.js";
import type { ComputeResultsBody, ComputeSessionResultsBody, OverrideResultBody } from "./results.schemas.js";

// ---------------------------------------------------------------------------
// Fee withholding (Feature D)
// ---------------------------------------------------------------------------

interface Withholding {
  outstandingKobo: number;
  feeObligationIds: string[];
}

/// Batched version of the per-term withholding check, used by
/// listResultsForStudent so an N-term list does one query, not N. A term is
/// withheld by an obligation whose termId matches it directly, OR whose
/// termId is null (session-wide, e.g. a registration levy) and whose
/// academicSessionId matches the term's session — a session-wide debt
/// withholds every term's result in that session, not just one (see
/// decision log: the alternative would let a parent dodge a session-wide fee
/// more easily than a term-specific one).
async function buildWithholdingMap(
  studentId: string,
  terms: Array<{ id: string; academicSessionId: string }>,
): Promise<Map<string, Withholding>> {
  const map = new Map<string, Withholding>();
  if (terms.length === 0) {
    return map;
  }

  const termIds = terms.map((t) => t.id);
  const sessionIds = [...new Set(terms.map((t) => t.academicSessionId))];

  const obligations = await prisma.feeObligation.findMany({
    where: {
      studentId,
      status: { notIn: ["PAID", "WAIVED"] },
      OR: [{ termId: { in: termIds } }, { termId: null, academicSessionId: { in: sessionIds } }],
    },
    include: { payments: { where: { status: "CONFIRMED" } } },
  });
  if (obligations.length === 0) {
    return map;
  }
  const withBalances = obligations.map(withBalance);

  for (const term of terms) {
    const matching = withBalances.filter(
      (o) => o.termId === term.id || (o.termId === null && o.academicSessionId === term.academicSessionId),
    );
    const outstandingKobo = matching.reduce((sum, o) => sum + o.outstandingKobo, 0);
    if (outstandingKobo > 0) {
      map.set(term.id, { outstandingKobo, feeObligationIds: matching.map((o) => o.id) });
    }
  }
  return map;
}

async function getOutstandingWithholding(
  studentId: string,
  termId: string,
  academicSessionId: string,
): Promise<Withholding | null> {
  const map = await buildWithholdingMap(studentId, [{ id: termId, academicSessionId }]);
  return map.get(termId) ?? null;
}

/// Session-level analog: ANY outstanding obligation anywhere in the session
/// (term-specific or session-wide) withholds the session rollup. Release is
/// explicitly per-term (see releaseWithholding below) — releasing one term's
/// result does not affect this check. The session-result read has no
/// release path of its own; that's a deliberate scope limit, not an
/// oversight (see report).
async function getOutstandingWithholdingForSession(
  studentId: string,
  academicSessionId: string,
): Promise<Withholding | null> {
  const obligations = await prisma.feeObligation.findMany({
    where: { studentId, academicSessionId, status: { notIn: ["PAID", "WAIVED"] } },
    include: { payments: { where: { status: "CONFIRMED" } } },
  });
  if (obligations.length === 0) {
    return null;
  }
  const withBalances = obligations.map(withBalance);
  const outstandingKobo = withBalances.reduce((sum, o) => sum + o.outstandingKobo, 0);
  if (outstandingKobo <= 0) {
    return null;
  }
  return { outstandingKobo, feeObligationIds: withBalances.map((o) => o.id) };
}

function throwWithheld(info: Withholding): never {
  throw AppError.paymentRequired("This result is withheld pending payment of an outstanding balance.", {
    outstandingKobo: info.outstandingKobo,
    feeObligationIds: info.feeObligationIds,
  });
}

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

  if (accessLevel !== "FULL" && !result.feeWithholdingReleased) {
    const term = await prisma.term.findUniqueOrThrow({
      where: { id: termId },
      select: { academicSessionId: true },
    });
    const withholding = await getOutstandingWithholding(studentId, termId, term.academicSessionId);
    if (withholding) {
      throwWithheld(withholding);
    }
  }

  const ratings = await prisma.rating.findMany({
    where: { studentId, termId },
    include: { trait: { select: { id: true, category: true, name: true, order: true } } },
    orderBy: [{ trait: { category: "asc" } }, { trait: { order: "asc" } }],
  });

  return { ...result, ratings };
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

  // Batched, not per-row: one query for every term in this list rather than
  // N. A withheld term is represented as a reduced marker object (status:
  // "WITHHELD" + the outstanding amount/obligation ids) in place of the full
  // Result fields — distinguishable from a normal row by its `status`, so a
  // RESTRICTED caller can tell "not published yet" (simply absent from this
  // list, same as before) from "withheld pending payment" (present, but
  // marked) without a second round-trip per term.
  const withholdingMap =
    accessLevel === "FULL"
      ? new Map<string, Withholding>()
      : await buildWithholdingMap(
          studentId,
          results
            .filter((r) => !r.feeWithholdingReleased)
            .map((r) => ({ id: r.termId, academicSessionId: r.term.academicSession.id })),
        );

  return results.map(({ term, ...result }) => {
    const withholding = withholdingMap.get(result.termId);
    const termSummary = { id: term.id, name: term.name, order: term.order };
    if (withholding) {
      return {
        termId: result.termId,
        term: termSummary,
        session: term.academicSession,
        status: "WITHHELD" as const,
        outstandingKobo: withholding.outstandingKobo,
        feeObligationIds: withholding.feeObligationIds,
      };
    }
    return { ...result, term: termSummary, session: term.academicSession };
  });
}

export function listResultsForClass(classId: string, termId: string) {
  return prisma.result.findMany({
    where: { termId, enrollment: { classId } },
    include: { student: true },
    orderBy: [{ position: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Report-card snapshot fields + class-relative position (Feature B)
// ---------------------------------------------------------------------------

/// PRESENT + LATE both count as "the student was at school that day" — only
/// ABSENT doesn't. Scoped to CLOSED AttendanceSessions only: an OPEN session
/// that never closed is an incomplete record, not a real school day.
async function computeAttendanceSnapshot(
  studentId: string,
  classId: string,
  termId: string,
): Promise<{ daysPresent: number; daysSchoolOpened: number }> {
  const sessions = await prisma.attendanceSession.findMany({
    where: { classId, termId, status: "CLOSED" },
    select: { id: true },
  });
  const daysSchoolOpened = sessions.length;
  if (daysSchoolOpened === 0) {
    return { daysPresent: 0, daysSchoolOpened: 0 };
  }
  const daysPresent = await prisma.attendanceRecord.count({
    where: {
      studentId,
      attendanceSessionId: { in: sessions.map((s) => s.id) },
      status: { in: ["PRESENT", "LATE"] },
    },
  });
  return { daysPresent, daysSchoolOpened };
}

/// "Every actively-enrolled student in this class+term already has a
/// FINALIZED result" — the gate for the automatic position-fill pass.
/// Deliberately absolute: a class with one student whose data is
/// permanently incomplete never satisfies this, which is why the admin
/// escape hatch (rankClassResults) exists as an unconditional alternative.
async function isClassFullyFinalized(
  tx: Prisma.TransactionClient,
  classId: string,
  termId: string,
  academicSessionId: string,
): Promise<boolean> {
  const [enrollmentCount, finalizedCount] = await Promise.all([
    tx.enrollment.count({ where: { classId, academicSessionId, status: "ACTIVE" } }),
    tx.result.count({
      where: { termId, status: "FINALIZED", enrollment: { classId, academicSessionId, status: "ACTIVE" } },
    }),
  ]);
  return enrollmentCount > 0 && enrollmentCount === finalizedCount;
}

/// Ranks whatever's currently FINALIZED for this class+term, strictly among
/// those peers (never against a still-DRAFT classmate). Standard competition
/// ranking: ties share a position, the next position skips (1, 2, 2, 4, ...).
/// Results with a null averageScore (never had a submitted subject) are
/// excluded from ranking entirely, same as computeResultsForClass's own
/// live ranking.
async function rankFinalizedResults(tx: Prisma.TransactionClient, classId: string, termId: string): Promise<void> {
  const finalized = await tx.result.findMany({
    where: { termId, status: "FINALIZED", enrollment: { classId }, averageScore: { not: null } },
    select: { id: true, averageScore: true },
    orderBy: { averageScore: "desc" },
  });

  const outOf = finalized.length;
  let lastScore: string | null = null;
  let lastPosition = 0;
  for (const [i, row] of finalized.entries()) {
    const scoreKey = row.averageScore?.toString() ?? null;
    const position = scoreKey === lastScore ? lastPosition : i + 1;
    lastScore = scoreKey;
    lastPosition = position;
    await tx.result.update({ where: { id: row.id }, data: { position, outOf } });
  }
}

/// Serializes the "check completeness, then rank" sequence against a racing
/// finalize/rank for the SAME class+term — the exact transaction-scoped
/// pg_advisory_xact_lock pattern already used for AcademicSession/Term
/// "current" switching (academic-structure.service.ts), keyed the same
/// two-argument way (a fixed name hash + a hash of the varying key).
async function withPositionFillLock<T>(classId: string, termId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('result_position_fill'), hashtext(${`${classId}:${termId}`}))`;
    return fn(tx);
  });
}

export async function finalizeResult(id: string, actorUserId: string) {
  const result = await prisma.result.findUnique({
    where: { id },
    include: { enrollment: { select: { classId: true, academicSessionId: true } } },
  });
  if (!result) {
    throw AppError.notFound("Result not found");
  }
  if (result.status === "FINALIZED") {
    throw AppError.conflict("This result is already finalized");
  }

  const { daysPresent, daysSchoolOpened } = await computeAttendanceSnapshot(
    result.studentId,
    result.enrollment.classId,
    result.termId,
  );

  const finalized = await prisma.result.update({
    where: { id },
    data: {
      status: "FINALIZED",
      finalizedByUserId: actorUserId,
      finalizedAt: new Date(),
      daysPresent,
      daysSchoolOpened,
    },
  });

  const { classId, academicSessionId } = result.enrollment;
  await withPositionFillLock(classId, result.termId, async (tx) => {
    if (await isClassFullyFinalized(tx, classId, result.termId, academicSessionId)) {
      await rankFinalizedResults(tx, classId, result.termId);
    }
  });

  return finalized;
}

/// Admin escape hatch for a class that never reaches 100% finalized (e.g. a
/// student withdrew mid-term with incomplete data) — ranks whatever's
/// currently FINALIZED unconditionally, without waiting for every
/// actively-enrolled student to be done. Shares the same advisory lock key
/// as finalizeResult's automatic pass, so the two can never race each other
/// into an inconsistent double-write.
export async function rankClassResults(classId: string, termId: string) {
  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) {
    throw AppError.notFound("Term not found");
  }

  await withPositionFillLock(classId, termId, (tx) => rankFinalizedResults(tx, classId, termId));

  return prisma.result.findMany({ where: { termId, enrollment: { classId } }, orderBy: [{ position: "asc" }] });
}

/// Admin release of fee withholding for one term's result — an override of a
/// computed rule, following ResultOverride's exact pattern (fieldName
/// "feeWithholdingReleased", required reason). The conditional updateMany on
/// false -> true gives idempotency: a second release call is a no-op, no
/// duplicate audit row, still 200.
export async function releaseWithholding(id: string, actorUserId: string, reason: string) {
  const { count } = await prisma.result.updateMany({
    where: { id, status: "FINALIZED", feeWithholdingReleased: false },
    data: { feeWithholdingReleased: true },
  });

  if (count === 0) {
    const result = await prisma.result.findUnique({ where: { id } });
    if (!result) {
      throw AppError.notFound("Result not found");
    }
    if (result.status !== "FINALIZED") {
      throw AppError.badRequest("Only finalized results can have their fee withholding released");
    }
    return result;
  }

  await prisma.resultOverride.create({
    data: {
      targetType: "RESULT",
      resultId: id,
      fieldName: "feeWithholdingReleased",
      oldValue: false,
      newValue: true,
      reason,
      performedByUserId: actorUserId,
    },
  });

  return prisma.result.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// Session results (Feature A)
// ---------------------------------------------------------------------------

async function getSessionAverageMethod(academicSessionId: string): Promise<SessionAverageMethod> {
  const gradingScale = await prisma.gradingScale.findUnique({
    where: { academicSessionId },
    select: { sessionAverageMethod: true },
  });
  return gradingScale?.sessionAverageMethod ?? "SESSION_AVERAGE";
}

/// Rolls up a student's FINALIZED term Results for a class+session into one
/// SessionResult, per subject then overall — averaged (SESSION_AVERAGE) or
/// carried forward from the latest term (FINAL_TERM_CARRIES), per
/// GradingScale.sessionAverageMethod. A missing (never-finalized) term is
/// never counted as zero — it's simply excluded from that subject's average.
/// A student with zero FINALIZED terms gets no row at all yet. Purely
/// derived from already-finalized inputs, so every row this writes goes
/// straight to FINALIZED — there's no separate human review/finalize step
/// for the rollup itself.
export async function computeSessionResultsForClass(input: ComputeSessionResultsBody, actorUserId: string) {
  const session = await prisma.academicSession.findUnique({ where: { id: input.academicSessionId } });
  if (!session) {
    throw AppError.notFound("Academic session not found");
  }
  const klass = await prisma.class.findUnique({ where: { id: input.classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }

  const enrollments = await prisma.enrollment.findMany({
    where: { classId: input.classId, academicSessionId: input.academicSessionId, status: "ACTIVE" },
  });
  if (enrollments.length === 0) {
    throw AppError.badRequest("No students are actively enrolled in this class for this session");
  }
  const studentIds = enrollments.map((e) => e.studentId);

  const terms = await prisma.term.findMany({ where: { academicSessionId: input.academicSessionId } });
  const termOrderById = new Map(terms.map((t) => [t.id, t.order]));
  const method = await getSessionAverageMethod(input.academicSessionId);

  const finalizedResults = await prisma.result.findMany({
    where: { studentId: { in: studentIds }, termId: { in: terms.map((t) => t.id) }, status: "FINALIZED" },
    select: { studentId: true, termId: true },
  });
  const finalizedTermIdsByStudent = new Map<string, Set<string>>();
  for (const r of finalizedResults) {
    const set = finalizedTermIdsByStudent.get(r.studentId) ?? new Set<string>();
    set.add(r.termId);
    finalizedTermIdsByStudent.set(r.studentId, set);
  }

  const allFinalizedTermIds = [...new Set(finalizedResults.map((r) => r.termId))];
  const subjectResults =
    allFinalizedTermIds.length > 0
      ? await prisma.subjectResult.findMany({
          where: { studentId: { in: studentIds }, termId: { in: allFinalizedTermIds } },
          include: { classSubjectAssignment: { select: { subjectId: true } } },
        })
      : [];

  interface ComputedSubject {
    subjectId: string;
    averageScore: number;
    termsCounted: number;
  }
  const computed: Array<{
    enrollmentId: string;
    studentId: string;
    subjects: ComputedSubject[];
    overallAverage: number | null;
  }> = [];

  for (const enrollment of enrollments) {
    const finalizedTermIds = finalizedTermIdsByStudent.get(enrollment.studentId);
    if (!finalizedTermIds || finalizedTermIds.size === 0) {
      continue;
    }

    const studentSubjectResults = subjectResults.filter(
      (sr) => sr.studentId === enrollment.studentId && finalizedTermIds.has(sr.termId),
    );
    const bySubject = new Map<string, typeof studentSubjectResults>();
    for (const sr of studentSubjectResults) {
      const list = bySubject.get(sr.classSubjectAssignment.subjectId) ?? [];
      list.push(sr);
      bySubject.set(sr.classSubjectAssignment.subjectId, list);
    }

    const subjects: ComputedSubject[] = [];
    for (const [subjectId, srs] of bySubject) {
      if (method === "FINAL_TERM_CARRIES") {
        const latest = srs.reduce((best, sr) =>
          (termOrderById.get(sr.termId) ?? -1) > (termOrderById.get(best.termId) ?? -1) ? sr : best,
        );
        subjects.push({ subjectId, averageScore: latest.totalScore.toNumber(), termsCounted: 1 });
      } else {
        const sum = srs.reduce((acc, sr) => acc + sr.totalScore.toNumber(), 0);
        subjects.push({ subjectId, averageScore: sum / srs.length, termsCounted: srs.length });
      }
    }

    const overallAverage =
      subjects.length > 0 ? subjects.reduce((acc, s) => acc + s.averageScore, 0) / subjects.length : null;

    computed.push({ enrollmentId: enrollment.id, studentId: enrollment.studentId, subjects, overallAverage });
  }

  await prisma.$transaction(async (tx) => {
    for (const c of computed) {
      const sessionResult = await tx.sessionResult.upsert({
        where: {
          studentId_academicSessionId: { studentId: c.studentId, academicSessionId: input.academicSessionId },
        },
        create: {
          studentId: c.studentId,
          enrollmentId: c.enrollmentId,
          academicSessionId: input.academicSessionId,
          status: "FINALIZED",
          averageScore: c.overallAverage,
          finalizedByUserId: actorUserId,
          finalizedAt: new Date(),
        },
        update: {
          status: "FINALIZED",
          averageScore: c.overallAverage,
          finalizedByUserId: actorUserId,
          finalizedAt: new Date(),
        },
      });

      await tx.sessionSubjectAverage.deleteMany({ where: { sessionResultId: sessionResult.id } });
      if (c.subjects.length > 0) {
        await tx.sessionSubjectAverage.createMany({
          data: c.subjects.map((s) => ({
            sessionResultId: sessionResult.id,
            subjectId: s.subjectId,
            averageScore: s.averageScore,
            termsCounted: s.termsCounted,
          })),
        });
      }
    }
  });

  return prisma.sessionResult.findMany({
    where: { studentId: { in: studentIds }, academicSessionId: input.academicSessionId },
    include: { subjectAverages: true },
  });
}

/// The session-result analog of getResultForStudentTerm: same
/// finalized-only visibility gate and the same fee-withholding rule
/// (Feature D), checked session-wide (see getOutstandingWithholdingForSession)
/// rather than against one term.
export async function getSessionResultForStudent(
  studentId: string,
  academicSessionId: string,
  principal: Principal,
) {
  const result = await prisma.sessionResult.findUnique({
    where: { studentId_academicSessionId: { studentId, academicSessionId } },
    include: { subjectAverages: { include: { subject: true } } },
  });
  if (!result) {
    throw AppError.notFound("No session result found for this student/session");
  }

  const accessLevel = await resolveStudentAccessLevel(principal, studentId);
  if (accessLevel !== "FULL" && result.status !== "FINALIZED") {
    throw AppError.notFound("No session result found for this student/session");
  }

  if (accessLevel !== "FULL") {
    const withholding = await getOutstandingWithholdingForSession(studentId, academicSessionId);
    if (withholding) {
      throwWithheld(withholding);
    }
  }

  return result;
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
