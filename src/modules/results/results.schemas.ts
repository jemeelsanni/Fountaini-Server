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
