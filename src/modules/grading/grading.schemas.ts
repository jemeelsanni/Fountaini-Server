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

// Every field optional, none nullable — AssessmentComponent has no nullable
// columns, so there's no undefined-vs-null distinction to preserve here
// (unlike updateParentSchema/updateGradeBandSchema).
export const updateAssessmentComponentSchema = createAssessmentComponentSchema.partial();
export type UpdateAssessmentComponentBody = z.infer<typeof updateAssessmentComponentSchema>;

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

// No cross-field maxScore > minScore refine here — on a partial update
// either field alone parses fine, and the invariant is checked in
// grading.service.ts's updateGradeBand against the merged (current + patch)
// values, since a schema-level check can only ever see the patch. remark
// and gradePoint are .nullable().optional() (they're nullable columns) so
// an admin can explicitly clear either one; grade/minScore/maxScore are
// required columns and stay .optional() only.
export const updateGradeBandSchema = z.object({
  grade: z.string().min(1).optional(),
  minScore: z.coerce.number().nonnegative().optional(),
  maxScore: z.coerce.number().positive().optional(),
  remark: z.string().min(1).nullable().optional(),
  gradePoint: z.coerce.number().nullable().optional(),
});
export type UpdateGradeBandBody = z.infer<typeof updateGradeBandSchema>;
