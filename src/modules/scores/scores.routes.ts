import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canActOnAssignment, canReadStudent } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./scores.controller.js";
import {
  bulkUpsertScoresSchema,
  idParamsSchema,
  type IdParams,
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
scoresRouter.get(
  "/students/:id/scores",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStudent(principal, (req.params as unknown as IdParams).id)),
  controller.getScoresForStudent,
);
