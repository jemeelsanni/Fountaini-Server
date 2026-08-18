import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createStudentSchema = z.object({
  admissionNumber: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  otherNames: z.string().min(1).optional(),
  dateOfBirth: z.coerce.date().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
  admissionDate: z.coerce.date().optional(),
  userId: z.string().min(1).optional(),
});
export type CreateStudentBody = z.infer<typeof createStudentSchema>;

export const updateStudentSchema = z.object({
  admissionNumber: z.string().min(1).optional(),
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
