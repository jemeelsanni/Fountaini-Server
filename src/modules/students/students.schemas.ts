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
  status: z.enum(["ACTIVE", "GRADUATED", "WITHDRAWN", "INACTIVE"]).optional(),
});
export type UpdateStudentBody = z.infer<typeof updateStudentSchema>;

export const createEnrollmentSchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type CreateEnrollmentBody = z.infer<typeof createEnrollmentSchema>;
