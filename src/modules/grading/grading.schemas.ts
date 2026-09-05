import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createAssessmentComponentSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["CA", "EXAM"]),
  maxScore: z.coerce.number().positive(),
  order: z.coerce.number().int().nonnegative(),
});
export type CreateAssessmentComponentBody = z.infer<typeof createAssessmentComponentSchema>;

/// A whole-body `.default({})`, not just an optional field: existing callers
/// send no body at all for this route (it used to have no body schema), so
/// req.body arrives as `undefined`, which a bare z.object(...) rejects
/// regardless of its fields' own optionality — `.default({})` is what makes
/// "no body sent" and "empty body sent" both valid, defaulting to
/// SESSION_AVERAGE (matching GradingScale's own DB default) either way. See
/// computeSessionResultsForClass in results.service.ts for the config flag
/// this actually feeds.
export const createGradingScaleSchema = z
  .object({
    sessionAverageMethod: z.enum(["SESSION_AVERAGE", "FINAL_TERM_CARRIES"]).optional(),
  })
  .default({});
export type CreateGradingScaleBody = z.infer<typeof createGradingScaleSchema>;

export const createGradeBandSchema = z
  .object({
    grade: z.string().min(1),
    minScore: z.coerce.number().nonnegative(),
    maxScore: z.coerce.number().positive(),
    remark: z.string().min(1).optional(),
    gradePoint: z.coerce.number().optional(),
  })
  .refine((data) => data.maxScore > data.minScore, {
    message: "maxScore must be greater than minScore",
    path: ["maxScore"],
  });
export type CreateGradeBandBody = z.infer<typeof createGradeBandSchema>;
