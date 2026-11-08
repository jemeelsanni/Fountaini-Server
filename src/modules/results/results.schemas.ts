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

export const listResultsForStudentQuerySchema = z.object({
  academicSessionId: z.string().min(1).optional(),
});
export type ListResultsForStudentQuery = z.infer<typeof listResultsForStudentQuerySchema>;

export const computeResultsSchema = z.object({
  classId: z.string().min(1),
  termId: z.string().min(1),
});
export type ComputeResultsBody = z.infer<typeof computeResultsSchema>;

export const computeSessionResultsSchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type ComputeSessionResultsBody = z.infer<typeof computeSessionResultsSchema>;

/// Which of a student's report cards to read — a student in both a regular
/// class and a Weekday Madrasa group has one result per programme per
/// term/session. Defaults to ACADEMIC so callers that predate the split
/// keep getting the result they always did.
export const programmeQuerySchema = z.object({
  programme: z.enum(["ACADEMIC", "MADRASSAH"]).default("ACADEMIC"),
});
export type ProgrammeQuery = z.infer<typeof programmeQuerySchema>;

/// Admin → Results' whole-school release: one term, optionally one programme.
export const termSummaryQuerySchema = z.object({
  termId: z.string().min(1),
  programme: z.enum(["ACADEMIC", "MADRASSAH"]).optional(),
});
export type TermSummaryQuery = z.infer<typeof termSummaryQuerySchema>;

export const finalizeAllSchema = termSummaryQuerySchema;
export type FinalizeAllBody = z.infer<typeof finalizeAllSchema>;

export const studentSessionParamsSchema = z.object({
  studentId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type StudentSessionParams = z.infer<typeof studentSessionParamsSchema>;

/// Same validation as overrideResultSchema's reason — a release is an
/// override of a computed rule and follows its exact pattern (see
/// releaseWithholding in results.service.ts).
export const releaseWithholdingSchema = z.object({
  reason: z.string().min(10, "A meaningful reason is required to release a withheld result"),
});
export type ReleaseWithholdingBody = z.infer<typeof releaseWithholdingSchema>;

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

/// The normal (non-override) comment write path — only valid while the
/// Result is still DRAFT; see writeClassTeacherComment/writePrincipalComment
/// in results.service.ts. Unlike overrideResultSchema, no `reason` field:
/// this isn't a correction that needs justifying, it's the routine first
/// write.
export const writeCommentSchema = z.object({
  comment: z.string().min(1),
});
export type WriteCommentBody = z.infer<typeof writeCommentSchema>;

/// PATCH /results/:id/early-years — the Creche/Early Years report's weight,
/// height and "Area(s) of reinforcement". Bounds match the columns'
/// Decimal(5,2) / Decimal(5,1).
export const writeEarlyYearsSchema = z
  .object({
    weightKg: z.number().positive().max(999.99).nullable().optional(),
    heightCm: z.number().positive().max(9999.9).nullable().optional(),
    areasOfReinforcement: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "Provide at least one of weightKg, heightCm or areasOfReinforcement",
  });
export type WriteEarlyYearsBody = z.infer<typeof writeEarlyYearsSchema>;
