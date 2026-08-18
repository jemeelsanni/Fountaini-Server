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
