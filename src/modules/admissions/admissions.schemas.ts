import { z } from "zod";
import { phoneSchema } from "../../lib/phone.js";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createEnquirySchema = z.object({
  prospectiveFirstName: z.string().min(1).max(100),
  prospectiveLastName: z.string().min(1).max(100),
  dateOfBirth: z.coerce.date().optional(),
  desiredClassId: z.string().min(1).optional(),
  parentFullName: z.string().min(1).max(200),
  // Normalised to E.164 by phoneSchema's own transform — the old .max(30)
  // free-text cap is redundant once structural validation is in place:
  // nothing that could pass it would also match the accepted shapes.
  parentPhone: phoneSchema,
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
