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

export const scoresForAssignmentQuerySchema = z.object({
  termId: z.string().min(1),
});
export type ScoresForAssignmentQuery = z.infer<typeof scoresForAssignmentQuerySchema>;

/// POST /class-subject-assignments/:id/scores/return — the form teacher
/// sends a submitted sheet back to its subject teacher.
export const returnScoresSchema = z.object({
  termId: z.string().min(1),
});
export type ReturnScoresBody = z.infer<typeof returnScoresSchema>;

export const classTermParamsSchema = z.object({
  id: z.string().min(1),
  termId: z.string().min(1),
});
export type ClassTermParams = z.infer<typeof classTermParamsSchema>;

/// GET /classes/:id/score-sheets/:termId — `programme` narrows to the
/// subjects feeding one report card; omitted, every subject in the class.
export const classScoreSheetsQuerySchema = z.object({
  programme: z.enum(["ACADEMIC", "MADRASSAH"]).optional(),
});
export type ClassScoreSheetsQuery = z.infer<typeof classScoreSheetsQuerySchema>;
