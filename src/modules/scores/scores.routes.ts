import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import {
  canActOnAssignment,
  canReadClassResults,
  canReadStudent,
  canReviewAssignmentScores,
} from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./scores.controller.js";
import {
  bulkUpsertScoresSchema,
  type ClassScoreSheetsQuery,
  classScoreSheetsQuerySchema,
  type ClassTermParams,
  classTermParamsSchema,
  idParamsSchema,
  type IdParams,
  returnScoresSchema,
  scoresForAssignmentQuerySchema,
  submitScoresSchema,
} from "./scores.schemas.js";

export const scoresRouter = Router();

scoresRouter.use(requireAuth);

const scopeToAssignment = requireScope((principal, req) =>
  canActOnAssignment(principal, (req.params as unknown as IdParams).id),
);

scoresRouter.get(
  "/class-subject-assignments/:id/students",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema }),
  scopeToAssignment,
  controller.getRoster,
);
scoresRouter.get(
  "/class-subject-assignments/:id/scores",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, query: scoresForAssignmentQuerySchema }),
  scopeToAssignment,
  controller.getScoresForAssignment,
);
scoresRouter.put(
  "/class-subject-assignments/:id/scores",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: bulkUpsertScoresSchema }),
  scopeToAssignment,
  controller.bulkUpsertScores,
);
scoresRouter.post(
  "/class-subject-assignments/:id/scores/submit",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: submitScoresSchema }),
  scopeToAssignment,
  auditMutation("SubjectResult", "SCORES_SUBMITTED"),
  controller.submitScores,
);
// Step 1 → 2 of the review chain goes backwards here: the form teacher
// (or admin) returns a submitted sheet to its subject teacher to fix. WHO is
// the scope resolver's; WHEN (only while the report cards are still with
// the form teacher) is the service's.
scoresRouter.post(
  "/class-subject-assignments/:id/scores/return",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: returnScoresSchema }),
  requireScope((principal, req) =>
    canReviewAssignmentScores(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("ClassSubjectAssignment", "SCORES_RETURNED_TO_TEACHER"),
  controller.returnScoresToTeacher,
);
// The form teacher's checklist: every subject sheet feeding the class's
// report card, and whether it's been submitted to them yet.
scoresRouter.get(
  "/classes/:id/score-sheets/:termId",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: classTermParamsSchema, query: classScoreSheetsQuerySchema }),
  requireScope((principal, req) => {
    const { id, termId } = req.params as unknown as ClassTermParams;
    return canReadClassResults(principal, id, termId, (req.validatedQuery as ClassScoreSheetsQuery).programme);
  }),
  controller.getClassScoreSheets,
);
scoresRouter.get(
  "/students/:id/scores",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStudent(principal, (req.params as unknown as IdParams).id)),
  controller.getScoresForStudent,
);
