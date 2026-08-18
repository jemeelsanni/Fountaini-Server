import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const studentTermParamsSchema = z.object({
  studentId: z.string().min(1),
  termId: z.string().min(1),
});
export type StudentTermParams = z.infer<typeof studentTermParamsSchema>;

export const classTermParamsSchema = z.object({
  id: z.string().min(1),
  termId: z.string().min(1),
});
export type ClassTermParams = z.infer<typeof classTermParamsSchema>;

export const computeResultsSchema = z.object({
  classId: z.string().min(1),
  termId: z.string().min(1),
});
export type ComputeResultsBody = z.infer<typeof computeResultsSchema>;

export const OVERRIDABLE_FIELDS = [
  "totalScore",
  "averageScore",
  "position",
  "outOf",
  "classTeacherComment",
  "principalComment",
] as const;

export const overrideResultSchema = z.object({
  fieldName: z.enum(OVERRIDABLE_FIELDS),
  newValue: z.string().min(1),
  reason: z.string().min(10, "A meaningful reason is required for overriding a finalized result"),
});
export type OverrideResultBody = z.infer<typeof overrideResultSchema>;
