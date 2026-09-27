import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./grading.controller.js";
import {
  createAssessmentComponentSchema,
  createGradeBandSchema,
  createGradingScaleSchema,
  idParamsSchema,
  updateAssessmentComponentSchema,
  updateGradeBandSchema,
} from "./grading.schemas.js";

export const gradingRouter = Router();

gradingRouter.use(requireAuth);

gradingRouter.post(
  "/academic-sessions/:id/assessment-components",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createAssessmentComponentSchema }),
  auditMutation("AssessmentComponent", "ASSESSMENT_COMPONENT_CREATED"),
  controller.createAssessmentComponent,
);
gradingRouter.get(
  "/academic-sessions/:id/assessment-components",
  requireRole(...ALL_ROLES),
  validate({ params: idParamsSchema }),
  controller.listAssessmentComponents,
);
// Editing maxScore after results have been computed from this component
// leaves those results stale until someone recomputes (see
// scores.service.ts's submitScores) — FINALIZED results are immutable and
// won't pick up the edit at all, so a mid-term edit can leave a class with
// some report cards built from the old component set and some from the
// new. Recomputing affected classes after an edit is an admin follow-up
// step this endpoint does not perform automatically. Editing maxScore may
// also leave the session's components no longer summing to 100 — see
// updateAssessmentComponent's own comment; the response carries a
// `warning` field when that happens rather than rejecting the edit.
gradingRouter.patch(
  "/assessment-components/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateAssessmentComponentSchema }),
  auditMutation("AssessmentComponent", "ASSESSMENT_COMPONENT_UPDATED"),
  controller.updateAssessmentComponent,
);
gradingRouter.delete(
  "/assessment-components/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("AssessmentComponent", "ASSESSMENT_COMPONENT_DELETED"),
  controller.deleteAssessmentComponent,
);

gradingRouter.post(
  "/academic-sessions/:id/grading-scale",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createGradingScaleSchema }),
  auditMutation("GradingScale", "GRADING_SCALE_CREATED"),
  controller.createGradingScale,
);
gradingRouter.get(
  "/academic-sessions/:id/grading-scale",
  requireRole(...ALL_ROLES),
  validate({ params: idParamsSchema }),
  controller.getGradingScaleForSession,
);

gradingRouter.post(
  "/grading-scales/:id/bands",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createGradeBandSchema }),
  auditMutation("GradeBand", "GRADE_BAND_CREATED"),
  controller.createGradeBand,
);
gradingRouter.patch(
  "/grade-bands/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateGradeBandSchema }),
  auditMutation("GradeBand", "GRADE_BAND_UPDATED"),
  controller.updateGradeBand,
);
gradingRouter.delete(
  "/grade-bands/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("GradeBand", "GRADE_BAND_DELETED"),
  controller.deleteGradeBand,
);
