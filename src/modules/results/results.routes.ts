import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./results.controller.js";
import {
  classTermParamsSchema,
  computeResultsSchema,
  idParamsSchema,
  overrideResultSchema,
  studentTermParamsSchema,
  type StudentTermParams,
} from "./results.schemas.js";

export const resultsRouter = Router();

resultsRouter.use(requireAuth);

resultsRouter.post(
  "/results/compute",
  requireRole("ADMIN"),
  validate({ body: computeResultsSchema }),
  controller.computeResults,
);
resultsRouter.get(
  "/results/:studentId/:termId",
  validate({ params: studentTermParamsSchema }),
  requireScope((principal, req) =>
    canReadStudent(principal, (req.params as unknown as StudentTermParams).studentId),
  ),
  controller.getResultForStudentTerm,
);
resultsRouter.get(
  "/classes/:id/results/:termId",
  requireRole("ADMIN"),
  validate({ params: classTermParamsSchema }),
  controller.listResultsForClass,
);
resultsRouter.post(
  "/results/:id/finalize",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Result", "RESULT_FINALIZED"),
  controller.finalizeResult,
);
resultsRouter.post(
  "/results/:id/override",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: overrideResultSchema }),
  auditMutation("Result", "RESULT_OVERRIDDEN"),
  controller.overrideResult,
);
