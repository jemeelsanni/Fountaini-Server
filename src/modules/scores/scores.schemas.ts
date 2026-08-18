import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const bulkUpsertScoresSchema = z.object({
  termId: z.string().min(1),
  entries: z
    .array(
      z.object({
        studentId: z.string().min(1),
        assessmentComponentId: z.string().min(1),
        rawScore: z.coerce.number().nonnegative(),
      }),
    )
    .min(1),
});
export type BulkUpsertScoresBody = z.infer<typeof bulkUpsertScoresSchema>;

export const submitScoresSchema = z.object({
  termId: z.string().min(1),
});
export type SubmitScoresBody = z.infer<typeof submitScoresSchema>;
