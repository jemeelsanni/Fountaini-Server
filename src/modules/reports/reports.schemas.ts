import { z } from "zod";

export const scopedReportQuerySchema = z.object({
  academicSessionId: z.string().min(1).optional(),
  termId: z.string().min(1).optional(),
});
export type ScopedReportQuery = z.infer<typeof scopedReportQuerySchema>;

export const paymentHistoryQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  status: z.enum(["PENDING", "CONFIRMED", "REJECTED"]).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type PaymentHistoryQuery = z.infer<typeof paymentHistoryQuerySchema>;
