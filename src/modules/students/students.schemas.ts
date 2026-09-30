import { z } from "zod";
import { ADMISSION_NUMBER_FORMAT } from "../identifiers/identifiers.service.js";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

const admissionNumberOverride = z
  .string()
  .regex(ADMISSION_NUMBER_FORMAT, "Must match FIA/<year>/<3-digit sequence>, e.g. FIA/2026/001");

// No issueLogin/email here (or on updateStudentSchema below) — a student's
// login is issued exactly when a primary-contact parent is linked (see
// parents.service.ts's linkChild), never at creation and never to an
// email of the student's own. See the report for why: a parent can't be
// linked yet at creation time regardless (studentId doesn't exist until
// this call returns), so a create-time issuance path could only ever have
// reached the no-destination fallback in practice.
export const createStudentSchema = z.object({
  // Optional: server-generated (FIA/<year>/<seq>) when omitted — see the
  // report. An explicit value is for importing a student who already has
  // a number from the school's paper records; it's validated for format
  // here and for uniqueness (and registered against the counter so it's
  // never reissued) in the service.
  admissionNumber: admissionNumberOverride.optional(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  otherNames: z.string().min(1).optional(),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
  admissionDate: z.coerce.date().optional(),
});
export type CreateStudentBody = z.infer<typeof createStudentSchema>;

export const updateStudentSchema = z.object({
  admissionNumber: admissionNumberOverride.optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  otherNames: z.string().min(1).optional(),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
  // Setting GRADUATED or WITHDRAWN here also closes this student's active
  // enrollment(s), same as PATCH /api/students/status — see
  // students.service.ts's ENROLLMENT_CLOSING_STATUS for exactly which
  // values do that and why INACTIVE deliberately doesn't.
  status: z.enum(["ACTIVE", "GRADUATED", "WITHDRAWN", "INACTIVE"]).optional(),
});
export type UpdateStudentBody = z.infer<typeof updateStudentSchema>;

// A few hundred, not unbounded — a large single grade-level cohort's worth
// of headroom for a graduation/withdrawal run, without accepting an
// arbitrarily large payload.
const MAX_BULK_STATUS_IDS = 500;

export const bulkUpdateStudentStatusSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_STATUS_IDS),
  status: z.enum(["ACTIVE", "INACTIVE", "GRADUATED", "WITHDRAWN"]),
});
export type BulkUpdateStudentStatusBody = z.infer<typeof bulkUpdateStudentStatusSchema>;

// Minimum 2 characters — a single character against a whole-school ILIKE
// '%q%' scan is both a near-useless result set and needless load; the
// picker this feeds is typeahead-style, so the UI can simply wait for a
// second keystroke rather than this endpoint doing anything cleverer.
// limit: default 20 (a picker dropdown's visible page), hard-capped at 50 —
// this is a typeahead lookup, not a paginated list, so there's no page/
// offset, only a result-count ceiling.
export const searchStudentsQuerySchema = z.object({
  q: z.string().trim().min(2),
  status: z.enum(["ACTIVE", "GRADUATED", "WITHDRAWN", "INACTIVE"]).optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
export type SearchStudentsQuery = z.infer<typeof searchStudentsQuerySchema>;

export const createEnrollmentSchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type CreateEnrollmentBody = z.infer<typeof createEnrollmentSchema>;

// In-place move between arms of the SAME grade level (e.g. JSS1 A to
// JSS1 B) in the student's current-session enrollment — see
// transferStudent's own comment (students.service.ts) for why a cross-
// grade move is rejected rather than handled here.
export const transferStudentSchema = z.object({
  classId: z.string().min(1),
});
export type TransferStudentBody = z.infer<typeof transferStudentSchema>;
