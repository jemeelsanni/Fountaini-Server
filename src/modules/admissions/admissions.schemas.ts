import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createEnquirySchema = z.object({
  prospectiveFirstName: z.string().min(1).max(100),
  prospectiveLastName: z.string().min(1).max(100),
  dateOfBirth: z.coerce.date().optional(),
  desiredClassId: z.string().min(1).optional(),
  parentFullName: z.string().min(1).max(200),
  parentPhone: z.string().min(1).max(30),
  parentEmail: z.email().max(200).optional(),
  message: z.string().min(1).max(2000).optional(),
  source: z.string().min(1).max(100).optional(),
});
export type CreateEnquiryBody = z.infer<typeof createEnquirySchema>;

export const listEnquiriesQuerySchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "CONVERTED", "CLOSED"]).optional(),
});
export type ListEnquiriesQuery = z.infer<typeof listEnquiriesQuerySchema>;

export const updateEnquirySchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "CONVERTED", "CLOSED"]).optional(),
  notes: z.string().min(1).max(2000).optional(),
});
export type UpdateEnquiryBody = z.infer<typeof updateEnquirySchema>;

export const convertEnquirySchema = z.object({
  admissionNumber: z.string().min(1),
});
export type ConvertEnquiryBody = z.infer<typeof convertEnquirySchema>;
