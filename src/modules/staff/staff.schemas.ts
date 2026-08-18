import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createStaffSchema = z.object({
  userId: z.string().min(1),
  staffNumber: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  otherNames: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  employmentDate: z.coerce.date().optional(),
});
export type CreateStaffBody = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  staffNumber: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  otherNames: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  employmentDate: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateStaffBody = z.infer<typeof updateStaffSchema>;
