import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const classTermParamsSchema = z.object({
  id: z.string().min(1),
  termId: z.string().min(1),
});
export type ClassTermParams = z.infer<typeof classTermParamsSchema>;

export const TRAIT_CATEGORIES = ["AFFECTIVE", "PSYCHOMOTOR"] as const;

export const createTraitSchema = z.object({
  category: z.enum(TRAIT_CATEGORIES),
  name: z.string().min(1),
  order: z.coerce.number().int().nonnegative(),
});
export type CreateTraitBody = z.infer<typeof createTraitSchema>;

/// value is bound-checked here (1-5) rather than against RatingScaleLevel in
/// the service: unlike AssessmentComponent.maxScore (which genuinely varies
/// per component), the 5-point scale is fixed and shared by both trait
/// categories, so a static schema bound is sufficient.
export const bulkUpsertRatingsSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: z.string().min(1),
        traitId: z.string().min(1),
        value: z.coerce.number().int().min(1).max(5),
      }),
    )
    .min(1),
});
export type BulkUpsertRatingsBody = z.infer<typeof bulkUpsertRatingsSchema>;
