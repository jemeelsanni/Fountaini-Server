import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import {
  canReadClassResults,
  canReadStudent,
  canWriteClassTeacherComment,
} from "../../authorization/scopeResolvers.js";
import { prisma } from "../../db/client.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./results.controller.js";
import {
  type ClassResultsQuery,
  classResultsQuerySchema,
  type ClassTermParams,
  classTermParamsSchema,
  computeResultsSchema,
  computeSessionResultsSchema,
  finalizeAllSchema,
  type IdParams,
  idParamsSchema,
  listResultsForStudentQuerySchema,
  overrideResultSchema,
  programmeQuerySchema,
  releaseWithholdingSchema,
  type StudentSessionParams,
  studentSessionParamsSchema,
  type StudentTermParams,
  studentTermParamsSchema,
  termSummaryQuerySchema,
  writeCommentSchema,
  writeEarlyYearsSchema,
} from "./results.schemas.js";

export const resultsRouter = Router();

resultsRouter.use(requireAuth);

resultsRouter.post(
  "/results/compute",
  requireRole("ADMIN"),
  validate({ body: computeResultsSchema }),
  controller.computeResults,
);
// Registered before "/results/:studentId/:termId" for clarity, though a
// one-segment path can't match that two-segment pattern anyway. No
// requireScope: the service only ever reads the caller's own studentId and
// their own linked children — there's no id in the path to check.
resultsRouter.get(
  "/results/me",
  requireRole("PARENT", "STUDENT"),
  validate({ query: listResultsForStudentQuerySchema }),
  controller.listMyResults,
);
resultsRouter.get(
  "/results/:studentId/:termId",
  validate({ params: studentTermParamsSchema, query: programmeQuerySchema }),
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
  validate({ params: classTermParamsSchema, query: classResultsQuerySchema }),
  requireScope((principal, req) => {
    const { id, termId } = req.params as unknown as ClassTermParams;
    return canReadClassResults(principal, id, termId, (req.validatedQuery as ClassResultsQuery).programme);
  }),
  controller.listResultsForClass,
);
// Whole-school release for a term — Admin → Results' "Publish all". The
// summary shows what will (SUBMITTED) and won't (DRAFT) be published;
// finalize-all publishes every SUBMITTED result through finalizeResult and
// writes its own per-result audit rows (see finalizeAllForTerm), so no
// auditMutation here.
resultsRouter.get(
  "/results/term-summary",
  requireRole("ADMIN"),
  validate({ query: termSummaryQuerySchema }),
  controller.getTermResultsSummary,
);
resultsRouter.post(
  "/results/finalize-all",
  requireRole("ADMIN"),
  validate({ body: finalizeAllSchema }),
  controller.finalizeAllForTerm,
);
resultsRouter.post(
  "/results/:id/finalize",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Result", "RESULT_FINALIZED", {
    fetchBefore: (id) => prisma.result.findUnique({ where: { id } }),
  }),
  controller.finalizeResult,
);
// The form teacher's side of publishing: submit a DRAFT for an admin to
// publish (finalize, above, stays ADMIN-only), or take a SUBMITTED one back
// to DRAFT to fix it. Same WHO as the class-teacher comment — the form
// teacher of the result's class, or ADMIN; the status rules live in the
// service.
resultsRouter.post(
  "/results/:id/submit",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema }),
  requireScope((principal, req) =>
    canWriteClassTeacherComment(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("Result", "RESULT_SUBMITTED_FOR_REVIEW"),
  controller.submitResultForReview,
);
resultsRouter.post(
  "/results/:id/return-to-draft",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema }),
  requireScope((principal, req) =>
    canWriteClassTeacherComment(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("Result", "RESULT_RETURNED_TO_DRAFT"),
  controller.returnResultToDraft,
);
// Admin escape hatch: a class that never reaches 100% finalized (a student
// withdrew mid-term, say) never gets the automatic class-wide position pass
// finalizeResult triggers on its own — this ranks whatever's currently
// FINALIZED unconditionally so report cards aren't stuck without a position.
// No auditMutation() here — this route's :id is the class, not any Result,
// and its response is an array with no id of its own; rankClassResults
// writes its own per-Result RESULT_RANKED audit rows explicitly instead
// (see that function's comment).
resultsRouter.post(
  "/classes/:id/results/:termId/rank",
  requireRole("ADMIN"),
  validate({ params: classTermParamsSchema }),
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
  auditMutation("Result", "RESULT_WITHHOLDING_RELEASED", {
    fetchBefore: (id) => prisma.result.findUnique({ where: { id } }),
  }),
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
  validate({ params: studentSessionParamsSchema, query: programmeQuerySchema }),
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
// The Early Years report's weight/height/areas of reinforcement — the same
// WHO (form teacher of the result's class, or ADMIN) and WHEN (DRAFT only,
// in the service) as the class-teacher comment just above.
resultsRouter.patch(
  "/results/:id/early-years",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: writeEarlyYearsSchema }),
  requireScope((principal, req) =>
    canWriteClassTeacherComment(principal, (req.params as unknown as IdParams).id),
  ),
  auditMutation("Result", "EARLY_YEARS_DETAILS_WRITTEN"),
  controller.writeEarlyYearsDetails,
);
resultsRouter.patch(
  "/results/:id/principal-comment",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: writeCommentSchema }),
  auditMutation("Result", "PRINCIPAL_COMMENT_WRITTEN"),
  controller.writePrincipalComment,
);
