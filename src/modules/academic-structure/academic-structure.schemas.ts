import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createAcademicSessionSchema = z
  .object({
    name: z.string().min(1),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });
export type CreateAcademicSessionBody = z.infer<typeof createAcademicSessionSchema>;

export const createTermSchema = z
  .object({
    name: z.string().min(1),
    order: z.coerce.number().int().positive(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });
export type CreateTermBody = z.infer<typeof createTermSchema>;

export const createClassSchema = z.object({
  gradeName: z.string().min(1),
  arm: z.string().min(1).optional(),
  order: z.coerce.number().int().nonnegative(),
});
export type CreateClassBody = z.infer<typeof createClassSchema>;

export const createSubjectSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
  type: z.enum(["ACADEMIC", "MADRASSAH"]).default("ACADEMIC"),
});
export type CreateSubjectBody = z.infer<typeof createSubjectSchema>;

export const createClassSubjectAssignmentSchema = z.object({
  classId: z.string().min(1),
  subjectId: z.string().min(1),
  teacherId: z.string().min(1),
  academicSessionId: z.string().min(1),
});
export type CreateClassSubjectAssignmentBody = z.infer<typeof createClassSubjectAssignmentSchema>;
