import { prisma } from "../../db/client.js";
import { AppError } from "../../errors/AppError.js";
import type { BulkUpsertScoresBody } from "./scores.schemas.js";

async function getAssignmentOrThrow(id: string) {
  const assignment = await prisma.classSubjectAssignment.findUnique({ where: { id } });
  if (!assignment) {
    throw AppError.notFound("Class-subject assignment not found");
  }
  return assignment;
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
  // outright rather than silently overwritten — there's no "reopen" flow yet.
  const alreadySubmitted = await prisma.score.findFirst({
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

  return prisma.$transaction(
    input.entries.map((entry) =>
      prisma.score.upsert({
        where: {
          studentId_classSubjectAssignmentId_termId_assessmentComponentId: {
            studentId: entry.studentId,
            classSubjectAssignmentId: assignmentId,
            termId: input.termId,
            assessmentComponentId: entry.assessmentComponentId,
          },
        },
        create: {
          studentId: entry.studentId,
          classSubjectAssignmentId: assignmentId,
          termId: input.termId,
          assessmentComponentId: entry.assessmentComponentId,
          rawScore: entry.rawScore,
          enteredByUserId: actorUserId,
        },
        update: {
          rawScore: entry.rawScore,
          updatedByUserId: actorUserId,
        },
      }),
    ),
  );
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
          grade: r.grade,
          gradePoint: r.gradePoint,
          status: "SUBMITTED",
          submittedByUserId: actorUserId,
          submittedAt: new Date(),
        },
        update: {
          totalScore: r.totalScore,
          grade: r.grade,
          gradePoint: r.gradePoint,
          status: "SUBMITTED",
          submittedByUserId: actorUserId,
          submittedAt: new Date(),
        },
      }),
    ),
  ]);

  return prisma.subjectResult.findMany({
    where: {
      classSubjectAssignmentId: assignmentId,
      termId,
      studentId: { in: enrollments.map((e) => e.studentId) },
    },
  });
}

export function getScoresForStudent(studentId: string) {
  return prisma.subjectResult.findMany({
    where: { studentId },
    include: { classSubjectAssignment: { include: { subject: true } }, term: true },
    orderBy: { computedAt: "desc" },
  });
}
