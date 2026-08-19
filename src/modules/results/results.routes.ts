import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent, canWriteClassTeacherComment } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./results.controller.js";
import {
  classTermParamsSchema,
  computeResultsSchema,
  idParamsSchema,
  type IdParams,
  overrideResultSchema,
  studentTermParamsSchema,
  type StudentTermParams,
  writeCommentSchema,
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
// Routine (non-override) comment writes — only valid while the Result is
// DRAFT (enforced in the service as a 400, not here: WHO may write is an
// authorization concern, WHEN is business state — same split every other
// scope-resolved route in this file already draws). Once FINALIZED, these
// both 400, and the /override route above is the only remaining path — its
// own FINALIZED-only behavior is untouched by any of this.
resultsRouter.patch(
  "/results/:id/class-teacher-comment",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: writeCommentSchema }),
  requireScope((principal, req) =>
    canWriteClassTeacherComment(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("Result", "CLASS_TEACHER_COMMENT_WRITTEN"),
  controller.writeClassTeacherComment,
);
resultsRouter.patch(
  "/results/:id/principal-comment",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: writeCommentSchema }),
  auditMutation("Result", "PRINCIPAL_COMMENT_WRITTEN"),
  controller.writePrincipalComment,
);
