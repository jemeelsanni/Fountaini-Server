import type { Programme } from "../../../generated/prisma/index.js";
import { resolveStudentAccessLevel } from "../../authorization/scopeResolvers.js";
import type { Principal } from "../../authorization/types.js";
import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import { subjectCardWhere } from "../results/reportCards.js";
import { computeResultsForClass, publishedCardKeysForStudent } from "../results/results.service.js";
import type { BulkUpsertScoresBody, ClassScoreSheetsQuery } from "./scores.schemas.js";

async function getAssignmentOrThrow(id: string) {
  const assignment = await prisma.classSubjectAssignment.findUnique({
    where: { id },
    include: { subject: { select: { type: true } }, class: { select: { programme: true } } },
  });
  if (!assignment) {
    throw AppError.notFound("Class-subject assignment not found");
  }
  return assignment;
}

/// Which report card an assignment's marks count towards — the same rule
/// as subjectCardWhere (results/reportCards.ts): Islamiyyah subjects, and
/// everything taught in a Madrasa group, go on the Islamiyyah card.
export function cardOfAssignment(assignment: {
  subject: { type: string };
  class: { programme: string };
}): Programme {
  return assignment.subject.type === "MADRASSAH" || assignment.class.programme === "MADRASSAH"
    ? "MADRASSAH"
    : "ACADEMIC";
}

/// A subject sheet goes to the form teacher, so it can only change while
/// the report cards it feeds are still with them (DRAFT). Once the form
/// teacher has sent them to the admin, they must withdraw them first; once
/// published, only an admin override can change a mark. Returns why the
/// cards are locked, or null; callers throw the 409 themselves (so the
/// OpenAPI conflict scanner can see it from the route).
async function cardsLockedReason(studentIds: string[], termId: string, programme: Programme) {
  const locked = await prisma.result.findFirst({
    where: { studentId: { in: studentIds }, termId, programme, status: { in: ["SUBMITTED", "FINALIZED"] } },
    select: { status: true },
    orderBy: { status: "desc" },
  });
  if (!locked) {
    return null;
  }
  return locked.status === "FINALIZED"
    ? "These report cards have already been published — a mark can now only change through an admin override"
    : "The form teacher has already sent these report cards to the admin — they need to withdraw them first";
}

/// Rebuilds the DRAFT report cards a sheet feeds, so the form teacher sees
/// the latest submitted marks without anyone having to press "Compute".
/// A regular class's Islamiyyah subject also feeds the Islamiyyah card of
/// any student whose card lives with their Weekday Madrasa group instead
/// (see enrollmentsForCard), so those groups are rebuilt too.
async function refreshReportCards(
  assignment: { classId: string; academicSessionId: string },
  programme: Programme,
  studentIds: string[],
  termId: string,
) {
  await computeResultsForClass({ classId: assignment.classId, termId });
  if (programme !== "MADRASSAH") {
    return;
  }
  const groups = await prisma.enrollment.findMany({
    where: {
      studentId: { in: studentIds },
      academicSessionId: assignment.academicSessionId,
      status: "ACTIVE",
      programme: "MADRASSAH",
      classId: { not: assignment.classId },
    },
    distinct: ["classId"],
    select: { classId: true },
  });
  for (const { classId } of groups) {
    await computeResultsForClass({ classId, termId });
  }
}

export async function getRoster(assignmentId: string) {
  const assignment = await getAssignmentOrThrow(assignmentId);
  const enrollments = await prisma.enrollment.findMany({
    where: { classId: assignment.classId, academicSessionId: assignment.academicSessionId, status: "ACTIVE" },
    include: { student: true },
    orderBy: { student: { lastName: "asc" } },
  });
  return enrollments.map((e) => e.student);
}

export async function bulkUpsertScores(assignmentId: string, actorUserId: string, input: BulkUpsertScoresBody) {
  const assignment = await getAssignmentOrThrow(assignmentId);

  const term = await prisma.term.findUnique({ where: { id: input.termId } });
  if (!term || term.academicSessionId !== assignment.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this assignment's academic session");
  }

  const componentIds = [...new Set(input.entries.map((e) => e.assessmentComponentId))];
  const components = await prisma.assessmentComponent.findMany({
    where: { id: { in: componentIds }, academicSessionId: assignment.academicSessionId },
  });
  const componentById = new Map(components.map((c) => [c.id, c]));

  const studentIds = [...new Set(input.entries.map((e) => e.studentId))];
  const enrollments = await prisma.enrollment.findMany({
    where: {
      studentId: { in: studentIds },
      classId: assignment.classId,
      academicSessionId: assignment.academicSessionId,
      status: "ACTIVE",
    },
  });
  const enrolledStudentIds = new Set(enrollments.map((e) => e.studentId));

  for (const entry of input.entries) {
    const component = componentById.get(entry.assessmentComponentId);
    if (!component) {
      throw AppError.badRequest(
        `Assessment component ${entry.assessmentComponentId} does not belong to this session`,
      );
    }
    if (entry.rawScore > component.maxScore.toNumber()) {
      throw AppError.badRequest(
        `Score ${entry.rawScore} exceeds the maximum of ${component.maxScore.toString()} for ${component.code}`,
      );
    }
    if (!enrolledStudentIds.has(entry.studentId)) {
      throw AppError.badRequest(`Student ${entry.studentId} is not actively enrolled in this class/session`);
    }
  }

  // Editing an already-submitted score through this endpoint is rejected
  // outright rather than silently overwritten — there's no "reopen" flow
  // yet. This read and the writes below now happen inside one transaction,
  // and — more importantly — each entry's write re-checks status at write
  // time too, not just at this read's time: a submitScores() committing in
  // between would otherwise go unnoticed, and the plain upsert() this
  // replaced had no way to express "skip this cell if it's since become
  // SUBMITTED" — it would silently overwrite a just-submitted Score row
  // while the SubjectResult already computed FROM that score stays stale,
  // so the score sheet and the subject result disagree (and any later
  // computeResultsForClass builds the Result from that stale
  // SubjectResult). The DB refuses the write now instead of app logic
  // merely trying to remember to check.
  return prisma.$transaction(async (tx) => {
    const alreadySubmitted = await tx.score.findFirst({
      where: {
        classSubjectAssignmentId: assignmentId,
        termId: input.termId,
        assessmentComponentId: { in: componentIds },
        studentId: { in: studentIds },
        status: "SUBMITTED",
      },
    });
    if (alreadySubmitted) {
      throw AppError.conflict(
        "One or more of these scores have already been submitted and can no longer be edited this way",
      );
    }

    const cellKey = (studentId: string, assessmentComponentId: string) => `${studentId}:${assessmentComponentId}`;
    const existing = await tx.score.findMany({
      where: {
        classSubjectAssignmentId: assignmentId,
        termId: input.termId,
        OR: input.entries.map((e) => ({
          studentId: e.studentId,
          assessmentComponentId: e.assessmentComponentId,
        })),
      },
      select: { studentId: true, assessmentComponentId: true },
    });
    const existingCells = new Set(existing.map((s) => cellKey(s.studentId, s.assessmentComponentId)));

    const toCreate = input.entries.filter(
      (e) => !existingCells.has(cellKey(e.studentId, e.assessmentComponentId)),
    );
    const toUpdate = input.entries.filter((e) =>
      existingCells.has(cellKey(e.studentId, e.assessmentComponentId)),
    );

    if (toCreate.length > 0) {
      await tx.score.createMany({
        data: toCreate.map((entry) => ({
          studentId: entry.studentId,
          classSubjectAssignmentId: assignmentId,
          termId: input.termId,
          assessmentComponentId: entry.assessmentComponentId,
          rawScore: entry.rawScore,
          enteredByUserId: actorUserId,
        })),
        // Two concurrent bulk-upserts racing to create the same
        // never-before-entered (student, component) cell — the loser's row
        // is dropped rather than erroring; the winner's value stands.
        skipDuplicates: true,
      });
    }

    for (const entry of toUpdate) {
      const { count } = await tx.score.updateMany({
        where: {
          studentId: entry.studentId,
          classSubjectAssignmentId: assignmentId,
          termId: input.termId,
          assessmentComponentId: entry.assessmentComponentId,
          status: { not: "SUBMITTED" },
        },
        data: { rawScore: entry.rawScore, updatedByUserId: actorUserId },
      });
      if (count === 0) {
        // Raced: this cell became SUBMITTED after the check above but
        // before this specific write reached it. Refuse the whole batch —
        // matching the pre-existing "rejected outright" guarantee — rather
        // than silently apply every other entry while this one goes stale.
        throw AppError.conflict(
          "One or more of these scores have already been submitted and can no longer be edited this way",
        );
      }
    }

    return tx.score.findMany({
      where: {
        classSubjectAssignmentId: assignmentId,
        termId: input.termId,
        studentId: { in: studentIds },
        assessmentComponentId: { in: componentIds },
      },
    });
  });
}

export async function submitScores(assignmentId: string, actorUserId: string, termId: string) {
  const assignment = await getAssignmentOrThrow(assignmentId);

  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term || term.academicSessionId !== assignment.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this assignment's academic session");
  }

  const components = await prisma.assessmentComponent.findMany({
    where: { academicSessionId: assignment.academicSessionId },
  });
  if (components.length === 0) {
    throw AppError.badRequest("No assessment components are configured for this academic session");
  }

  const enrollments = await prisma.enrollment.findMany({
    where: { classId: assignment.classId, academicSessionId: assignment.academicSessionId, status: "ACTIVE" },
  });
  if (enrollments.length === 0) {
    throw AppError.badRequest("No students are actively enrolled in this class for this session");
  }
  const programme = cardOfAssignment(assignment);
  const lockedReason = await cardsLockedReason(
    enrollments.map((e) => e.studentId),
    termId,
    programme,
  );
  if (lockedReason) {
    throw AppError.conflict(lockedReason);
  }

  const scores = await prisma.score.findMany({
    where: {
      classSubjectAssignmentId: assignmentId,
      termId,
      studentId: { in: enrollments.map((e) => e.studentId) },
    },
  });
  const scoreKey = (studentId: string, componentId: string) => `${studentId}:${componentId}`;
  const scoreMap = new Map(scores.map((s) => [scoreKey(s.studentId, s.assessmentComponentId), s]));

  const missing: string[] = [];
  for (const enrollment of enrollments) {
    for (const component of components) {
      if (!scoreMap.has(scoreKey(enrollment.studentId, component.id))) {
        missing.push(`student ${enrollment.studentId} is missing component ${component.code}`);
      }
    }
  }
  if (missing.length > 0) {
    throw AppError.badRequest("Cannot submit: some students are missing scores", missing);
  }

  const gradingScale = await prisma.gradingScale.findUnique({
    where: { academicSessionId: assignment.academicSessionId },
    include: { bands: true },
  });

  // Snapshotted now, from these same already-loaded components — not
  // derived on read later. Same reasoning as Result.daysPresent/position:
  // components are editable, and a report card printed in December must
  // not change in March because someone rebalanced CA/exam weights. No
  // extra query: `components` is the full, in-scope list already fetched
  // above for totalScore itself.
  const maxScore = components.reduce((sum, component) => sum + component.maxScore.toNumber(), 0);

  const subjectResults = enrollments.map((enrollment) => {
    const totalScore = components.reduce((sum, component) => {
      const score = scoreMap.get(scoreKey(enrollment.studentId, component.id));
      return sum + (score ? score.rawScore.toNumber() : 0);
    }, 0);

    const band = gradingScale?.bands.find(
      (b) => totalScore >= b.minScore.toNumber() && totalScore <= b.maxScore.toNumber(),
    );

    return {
      studentId: enrollment.studentId,
      totalScore,
      maxScore,
      grade: band?.grade ?? null,
      gradePoint: band?.gradePoint ? band.gradePoint.toNumber() : null,
    };
  });

  await prisma.$transaction([
    prisma.score.updateMany({
      where: {
        classSubjectAssignmentId: assignmentId,
        termId,
        studentId: { in: enrollments.map((e) => e.studentId) },
      },
      data: { status: "SUBMITTED" },
    }),
    ...subjectResults.map((r) =>
      prisma.subjectResult.upsert({
        where: {
          studentId_classSubjectAssignmentId_termId: {
            studentId: r.studentId,
            classSubjectAssignmentId: assignmentId,
            termId,
          },
        },
        create: {
          studentId: r.studentId,
          classSubjectAssignmentId: assignmentId,
          termId,
          totalScore: r.totalScore,
          maxScore: r.maxScore,
          grade: r.grade,
          gradePoint: r.gradePoint,
          status: "SUBMITTED",
          submittedByUserId: actorUserId,
          submittedAt: new Date(),
        },
        update: {
          totalScore: r.totalScore,
          maxScore: r.maxScore,
          grade: r.grade,
          gradePoint: r.gradePoint,
          status: "SUBMITTED",
          submittedByUserId: actorUserId,
          submittedAt: new Date(),
        },
      }),
    ),
  ]);

  // Hand-off to the form teacher: their class's DRAFT report cards now
  // include this subject.
  await refreshReportCards(assignment, programme, enrollments.map((e) => e.studentId), termId);

  return prisma.subjectResult.findMany({
    where: {
      classSubjectAssignmentId: assignmentId,
      termId,
      studentId: { in: enrollments.map((e) => e.studentId) },
    },
  });
}

/// The form teacher (or admin) sends a submitted subject sheet back to its
/// subject teacher: scores and subject results return to DRAFT, so the
/// sheet is editable again and its marks drop off the report cards until
/// it's resubmitted. Only while those cards are still with the form
/// teacher (see cardsLockedReason).
export async function returnScoresToTeacher(assignmentId: string, termId: string) {
  const assignment = await getAssignmentOrThrow(assignmentId);

  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term || term.academicSessionId !== assignment.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this assignment's academic session");
  }

  const submitted = await prisma.score.findMany({
    where: { classSubjectAssignmentId: assignmentId, termId, status: "SUBMITTED" },
    select: { studentId: true },
    distinct: ["studentId"],
  });
  if (submitted.length === 0) {
    throw AppError.badRequest("This sheet hasn't been submitted, so there's nothing to return");
  }
  const studentIds = submitted.map((s) => s.studentId);
  const programme = cardOfAssignment(assignment);
  const lockedReason = await cardsLockedReason(studentIds, termId, programme);
  if (lockedReason) {
    throw AppError.conflict(lockedReason);
  }

  await prisma.$transaction([
    prisma.score.updateMany({
      where: { classSubjectAssignmentId: assignmentId, termId },
      data: { status: "DRAFT" },
    }),
    prisma.subjectResult.updateMany({
      where: { classSubjectAssignmentId: assignmentId, termId },
      data: { status: "DRAFT", submittedByUserId: null, submittedAt: null },
    }),
  ]);

  await refreshReportCards(assignment, programme, studentIds, termId);

  return getScoresForAssignment(assignmentId, termId);
}

type SheetStatus = "NOT_STARTED" | "DRAFT" | "SUBMITTED";

/// The form teacher's view of every subject sheet feeding a class's report
/// card for a term: who teaches it, how far along it is, and whether it's
/// been submitted to them. `programme` picks the card (omitted: every
/// subject in the class).
export async function getClassScoreSheets(classId: string, termId: string, query: ClassScoreSheetsQuery) {
  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term) {
    throw AppError.notFound("Term not found");
  }
  const klass = await prisma.class.findUnique({ where: { id: classId } });
  if (!klass) {
    throw AppError.notFound("Class not found");
  }

  const [assignments, components, enrolledCount] = await Promise.all([
    prisma.classSubjectAssignment.findMany({
      where: {
        classId,
        academicSessionId: term.academicSessionId,
        ...(query.programme ? subjectCardWhere(query.programme) : {}),
      },
      include: {
        subject: { select: { id: true, name: true, code: true, type: true } },
        class: { select: { programme: true } },
        teacher: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { subject: { name: "asc" } },
    }),
    prisma.assessmentComponent.count({ where: { academicSessionId: term.academicSessionId } }),
    prisma.enrollment.count({
      where: { classId, academicSessionId: term.academicSessionId, status: "ACTIVE" },
    }),
  ]);

  const grouped = await prisma.score.groupBy({
    by: ["classSubjectAssignmentId", "status"],
    where: { classSubjectAssignmentId: { in: assignments.map((a) => a.id) }, termId },
    _count: { _all: true },
  });
  const submittedAt = await prisma.subjectResult.groupBy({
    by: ["classSubjectAssignmentId"],
    where: { classSubjectAssignmentId: { in: assignments.map((a) => a.id) }, termId, status: "SUBMITTED" },
    _max: { submittedAt: true },
  });
  const submittedAtById = new Map(submittedAt.map((r) => [r.classSubjectAssignmentId, r._max.submittedAt]));

  return assignments.map((a) => {
    const counts = grouped.filter((g) => g.classSubjectAssignmentId === a.id);
    const entered = counts.reduce((sum, g) => sum + g._count._all, 0);
    const status: SheetStatus = counts.some((g) => g.status === "SUBMITTED")
      ? "SUBMITTED"
      : entered > 0
        ? "DRAFT"
        : "NOT_STARTED";
    return {
      classSubjectAssignmentId: a.id,
      subject: a.subject,
      programme: cardOfAssignment(a),
      teacher: a.teacher,
      status,
      enteredCount: entered,
      expectedCount: components * enrolledCount,
      submittedAt: status === "SUBMITTED" ? (submittedAtById.get(a.id) ?? null) : null,
    };
  });
}

/// Repopulates the entry sheet for a class-subject-assignment+term: every
/// actively-enrolled student, every configured assessment component for
/// that session, and the entered rawScore for each (student, component)
/// pair — or null where nothing's been entered yet. Deliberately returns
/// DRAFT scores; the finalized-only visibility filter that governs the
/// parent/student path (see resolveStudentAccessLevel) has no business
/// here — this route is teacher-facing and its whole purpose is showing
/// what's been entered so far.
///
/// Submission is all-or-nothing per assignment+term (bulkUpsertScores/
/// submitScores enforce it), so the Score rows for one assignment+term are
/// never a mix of DRAFT and SUBMITTED — the presence of any SUBMITTED row
/// is enough to say the whole sheet is submitted. If partial submission is
/// ever introduced, this derivation stops being valid; a test pins this
/// invariant deliberately (see scores.test.ts) so that change breaks
/// loudly here instead of silently mislabeling a partially-submitted sheet
/// as DRAFT.
export async function getScoresForAssignment(assignmentId: string, termId: string) {
  const assignment = await getAssignmentOrThrow(assignmentId);

  const term = await prisma.term.findUnique({ where: { id: termId } });
  if (!term || term.academicSessionId !== assignment.academicSessionId) {
    throw AppError.badRequest("Term does not belong to this assignment's academic session");
  }

  const [enrollments, components, scores] = await Promise.all([
    prisma.enrollment.findMany({
      where: { classId: assignment.classId, academicSessionId: assignment.academicSessionId, status: "ACTIVE" },
      include: { student: true },
      orderBy: { student: { lastName: "asc" } },
    }),
    prisma.assessmentComponent.findMany({
      where: { academicSessionId: assignment.academicSessionId },
      orderBy: { order: "asc" },
    }),
    prisma.score.findMany({
      where: { classSubjectAssignmentId: assignmentId, termId },
    }),
  ]);

  const scoreKey = (studentId: string, assessmentComponentId: string) => `${studentId}:${assessmentComponentId}`;
  const scoreMap = new Map(scores.map((s) => [scoreKey(s.studentId, s.assessmentComponentId), s]));
  const status = scores.some((s) => s.status === "SUBMITTED") ? "SUBMITTED" : "DRAFT";

  const students = enrollments.map((enrollment) => ({
    studentId: enrollment.student.id,
    firstName: enrollment.student.firstName,
    lastName: enrollment.student.lastName,
    admissionNumber: enrollment.student.admissionNumber,
    scores: components.map((component) => {
      const existing = scoreMap.get(scoreKey(enrollment.student.id, component.id));
      return {
        assessmentComponentId: component.id,
        code: component.code,
        maxScore: component.maxScore,
        rawScore: existing?.rawScore ?? null,
      };
    }),
  }));

  return { status, students };
}

/// The assignment's subject (and so its type) and class (and so its
/// programme) are included so a client can split a student's Western and
/// Islamiyyah subjects the same way computeResultsForClass does (see
/// results/reportCards.ts) — from the work itself, not the student's
/// current enrollment, which a mid-term transfer edits in place.
///
/// Each row also carries its per-component marks (CA1/CA2/Exam) for the
/// report sheet: every component configured for the assignment's session,
/// in order, with rawScore null where no mark was recorded. Only the Score
/// rows behind this exact SubjectResult (same student, assignment, term) —
/// a SubjectResult only exists once those were submitted, so this exposes
/// nothing the total didn't already.
///
/// Only SUBMITTED subject results (a sheet returned to its teacher is a
/// draft again). A parent or student (RESTRICTED) only sees marks on cards
/// that are published and not withheld for fees — submitted marks are
/// still under review by the form teacher and admin until then.
export async function getScoresForStudent(studentId: string, principal: Principal) {
  const accessLevel = await resolveStudentAccessLevel(principal, studentId);
  const visible = accessLevel === "FULL" ? null : await publishedCardKeysForStudent(studentId);

  const subjectResults = (
    await prisma.subjectResult.findMany({
      where: { studentId, status: "SUBMITTED" },
      include: { classSubjectAssignment: { include: { subject: true, class: true } }, term: true },
      orderBy: { computedAt: "desc" },
    })
  ).filter(
    (sr) => visible === null || visible.has(`${sr.termId}:${cardOfAssignment(sr.classSubjectAssignment)}`),
  );
  if (subjectResults.length === 0) {
    return [];
  }

  const sessionIds = [...new Set(subjectResults.map((sr) => sr.classSubjectAssignment.academicSessionId))];
  const [components, scores] = await Promise.all([
    prisma.assessmentComponent.findMany({
      where: { academicSessionId: { in: sessionIds } },
      orderBy: { order: "asc" },
    }),
    prisma.score.findMany({
      where: {
        studentId,
        OR: subjectResults.map((sr) => ({
          classSubjectAssignmentId: sr.classSubjectAssignmentId,
          termId: sr.termId,
        })),
      },
    }),
  ]);

  const scoreKey = (assignmentId: string, termId: string, componentId: string) =>
    `${assignmentId}:${termId}:${componentId}`;
  const scoreMap = new Map(
    scores.map((s) => [scoreKey(s.classSubjectAssignmentId, s.termId, s.assessmentComponentId), s]),
  );

  return subjectResults.map((sr) => ({
    ...sr,
    components: components
      .filter((c) => c.academicSessionId === sr.classSubjectAssignment.academicSessionId)
      .map((c) => ({
        assessmentComponentId: c.id,
        code: c.code,
        name: c.name,
        type: c.type,
        maxScore: c.maxScore.toString(),
        rawScore: scoreMap.get(scoreKey(sr.classSubjectAssignmentId, sr.termId, c.id))?.rawScore.toString() ?? null,
        order: c.order,
      })),
  }));
}
