import { z } from "zod";
import { ADMISSION_NUMBER_FORMAT } from "../identifiers/identifiers.service.js";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

const admissionNumberOverride = z
  .string()
  .regex(ADMISSION_NUMBER_FORMAT, "Must match FIA/<year>/<3-digit sequence>, e.g. FIA/2026/001");

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
  // Issues a login immediately, in the same transaction as the student
  // record — most students won't have their own email at this point (no
  // parent can be linked yet either, since this student doesn't exist
  // until this call returns), so the common case is to leave this false
  // and issue the login later via PATCH /api/students/:id once a parent
  // is linked (see issueLogin there).
  issueLogin: z.boolean().optional().default(false),
  // The student's own email — only meaningful alongside issueLogin: true.
  email: z.string().email().optional(),
});
export type CreateStudentBody = z.infer<typeof createStudentSchema>;

export const updateStudentSchema = z
  .object({
    admissionNumber: admissionNumberOverride.optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    otherNames: z.string().min(1).optional(),
    dateOfBirth: z.coerce.date().optional(),
    gender: z.enum(["MALE", "FEMALE"]).optional(),
    status: z.enum(["ACTIVE", "GRADUATED", "WITHDRAWN", "INACTIVE"]).optional(),
    // Issues a login for a student who doesn't have one yet — replaces the
    // old userId field (see the report: an arbitrary pre-existing user no
    // longer makes sense to attach, since loginId must derive from THIS
    // student's own admissionNumber). Only settable while userId is
    // currently null — see updateStudent()'s conditional claim.
    issueLogin: z.boolean().optional(),
    // The student's own email — only meaningful alongside issueLogin: true.
    email: z.string().email().optional(),
  })
  .refine((data) => !data.email || data.issueLogin, {
    message: "email is only meaningful together with issueLogin",
    path: ["email"],
  });
export type UpdateStudentBody = z.infer<typeof updateStudentSchema>;

export const createEnrollmentSchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type CreateEnrollmentBody = z.infer<typeof createEnrollmentSchema>;
