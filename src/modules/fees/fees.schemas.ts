import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const createFeeStructureSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["TUITION", "REGISTRATION", "EXAM", "UNIFORM", "OTHER"]),
  classId: z.string().min(1).optional(),
  academicSessionId: z.string().min(1),
  termId: z.string().min(1).optional(),
  amountKobo: z.coerce.number().int().positive(),
});
export type CreateFeeStructureBody = z.infer<typeof createFeeStructureSchema>;

export const updateFeeObligationSchema = z.object({
  amountDueKobo: z.coerce.number().int().nonnegative().optional(),
  dueDate: z.coerce.date().optional(),
  status: z.enum(["PENDING", "PARTIALLY_PAID", "PAID", "WAIVED"]).optional(),
});
export type UpdateFeeObligationBody = z.infer<typeof updateFeeObligationSchema>;

export const recordPaymentSchema = z.object({
  amountKobo: z.coerce.number().int().positive(),
  bankReference: z.string().min(1).optional(),
  paymentDate: z.coerce.date(),
  notes: z.string().min(1).optional(),
});
export type RecordPaymentBody = z.infer<typeof recordPaymentSchema>;
