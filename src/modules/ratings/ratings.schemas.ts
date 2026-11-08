import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const classTermParamsSchema = z.object({
  id: z.string().min(1),
  termId: z.string().min(1),
});
export type ClassTermParams = z.infer<typeof classTermParamsSchema>;

export const TRAIT_CATEGORIES = ["AFFECTIVE", "PSYCHOMOTOR", "EARLY_YEARS"] as const;

/// EARLY_YEARS checklist items are rated in stars, 1-4 — enforced per trait
/// in bulkUpsertRatings, since the entry schema can't see a trait's category.
export const EARLY_YEARS_MAX_RATING = 4;

export const createTraitSchema = z.object({
  category: z.enum(TRAIT_CATEGORIES),
  name: z.string().min(1),
  // The heading an EARLY_YEARS item prints under; null/omitted otherwise.
  section: z.string().trim().min(1).nullable().optional(),
  order: z.coerce.number().int().nonnegative(),
});
export type CreateTraitBody = z.infer<typeof createTraitSchema>;

// Every field optional — same shape as updateAssessmentComponentSchema
// (grading.schemas.ts). section is the one nullable column: null clears it,
// omitted leaves it alone.
export const updateTraitSchema = createTraitSchema.partial();
export type UpdateTraitBody = z.infer<typeof updateTraitSchema>;

/// value is bound-checked here (1-5) rather than against RatingScaleLevel in
/// the service: unlike AssessmentComponent.maxScore (which genuinely varies
/// per component), the 5-point scale is fixed and shared by AFFECTIVE and
/// PSYCHOMOTOR. EARLY_YEARS' tighter 1-4 needs the trait, so it's checked in
/// bulkUpsertRatings. note holds an item's fill-in blanks ("|"-separated);
/// omitted leaves an existing note alone, null clears it.
export const bulkUpsertRatingsSchema = z.object({
  entries: z
    .array(
      z.object({
        studentId: z.string().min(1),
        traitId: z.string().min(1),
        value: z.coerce.number().int().min(1).max(5),
        note: z.string().max(100).nullable().optional(),
      }),
    )
    .min(1),
});
export type BulkUpsertRatingsBody = z.infer<typeof bulkUpsertRatingsSchema>;
