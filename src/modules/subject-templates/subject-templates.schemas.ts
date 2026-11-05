import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

/// Shared by POST and PATCH — PATCH takes the full body too, and `subjects`
/// always replaces the whole list (array order becomes `order`). A blank
/// name, duplicate subjectId or unknown subjectId are checked in the
/// service rather than here, so each gets its own readable 400 message
/// instead of validate()'s generic "Invalid request body".
export const subjectTemplateInputSchema = z.object({
  name: z.string().trim(),
  description: z
    .string()
    .trim()
    .nullish()
    .transform((value) => value || null),
  subjects: z.array(
    z.object({
      subjectId: z.string().min(1),
      optional: z.boolean().default(false),
    }),
  ),
});
export type SubjectTemplateInput = z.infer<typeof subjectTemplateInputSchema>;
