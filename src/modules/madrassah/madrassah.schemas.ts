import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createProgressSchema = z.object({
  studentId: z.string().min(1),
  academicSessionId: z.string().min(1),
  termId: z.string().min(1),
  surahId: z.string().min(1).optional(),
  ayahFrom: z.coerce.number().int().positive().optional(),
  ayahTo: z.coerce.number().int().positive().optional(),
  juzNumber: z.coerce.number().int().min(1).max(30).optional(),
  progressType: z.enum(["MEMORIZATION", "REVISION", "TAJWEED_ASSESSMENT"]),
  status: z.enum(["IN_PROGRESS", "COMPLETED", "NEEDS_REVISION"]).default("IN_PROGRESS"),
  tajweedNotes: z.string().min(1).optional(),
  generalNotes: z.string().min(1).optional(),
});
export type CreateProgressBody = z.infer<typeof createProgressSchema>;
