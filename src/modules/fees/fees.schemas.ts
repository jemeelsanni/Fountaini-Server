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

// dueDate is deliberately not here: FeeStructure has no dueDate field in
// the schema (it lives per-obligation, on FeeObligation, set at
// generation time) — only name/amountKobo are real, editable columns.
export const updateFeeStructureSchema = z.object({
  name: z.string().min(1).optional(),
  amountKobo: z.coerce.number().int().positive().optional(),
});
export type UpdateFeeStructureBody = z.infer<typeof updateFeeStructureSchema>;

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
