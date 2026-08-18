import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./grading.controller.js";
import {
  createAssessmentComponentSchema,
  createGradeBandSchema,
  idParamsSchema,
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
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema }),
  controller.listAssessmentComponents,
);

gradingRouter.post(
  "/academic-sessions/:id/grading-scale",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
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
