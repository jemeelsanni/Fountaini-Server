import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import {
  canReadClassResults,
  canReadStudent,
  canWriteClassTeacherComment,
} from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./results.controller.js";
import {
  type ClassTermParams,
  classTermParamsSchema,
  computeResultsSchema,
  computeSessionResultsSchema,
  idParamsSchema,
  type IdParams,
  listResultsForStudentQuerySchema,
  overrideResultSchema,
  releaseWithholdingSchema,
  studentSessionParamsSchema,
  type StudentSessionParams,
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
  "/students/:id/results",
  validate({ params: idParamsSchema, query: listResultsForStudentQuerySchema }),
  requireScope((principal, req) => canReadStudent(principal, (req.params as unknown as IdParams).id)),
  controller.listResultsForStudent,
);
resultsRouter.get(
  "/classes/:id/results/:termId",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: classTermParamsSchema }),
  requireScope((principal, req) => {
    const { id, termId } = req.params as unknown as ClassTermParams;
    return canReadClassResults(principal, id, termId);
  }),
  controller.listResultsForClass,
);
resultsRouter.post(
  "/results/:id/finalize",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Result", "RESULT_FINALIZED"),
  controller.finalizeResult,
);
// Admin escape hatch: a class that never reaches 100% finalized (a student
// withdrew mid-term, say) never gets the automatic class-wide position pass
// finalizeResult triggers on its own — this ranks whatever's currently
// FINALIZED unconditionally so report cards aren't stuck without a position.
resultsRouter.post(
  "/classes/:id/results/:termId/rank",
  requireRole("ADMIN"),
  validate({ params: classTermParamsSchema }),
  auditMutation("Result", "RESULT_RANKED"),
  controller.rankClassResults,
);
resultsRouter.post(
  "/results/:id/override",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: overrideResultSchema }),
  auditMutation("Result", "RESULT_OVERRIDDEN"),
  controller.overrideResult,
);
resultsRouter.post(
  "/results/:id/release-withholding",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: releaseWithholdingSchema }),
  auditMutation("Result", "RESULT_WITHHOLDING_RELEASED"),
  controller.releaseWithholding,
);
resultsRouter.post(
  "/session-results/compute",
  requireRole("ADMIN"),
  validate({ body: computeSessionResultsSchema }),
  controller.computeSessionResults,
);
resultsRouter.get(
  "/session-results/:studentId/:academicSessionId",
  validate({ params: studentSessionParamsSchema }),
  requireScope((principal, req) =>
    canReadStudent(principal, (req.params as unknown as StudentSessionParams).studentId),
  ),
  controller.getSessionResultForStudent,
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
