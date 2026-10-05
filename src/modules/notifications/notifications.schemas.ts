import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const triggerFeeRemindersSchema = z.object({
  academicSessionId: z.string().min(1).optional(),
});
export type TriggerFeeRemindersBody = z.infer<typeof triggerFeeRemindersSchema>;

export const listDeliveriesQuerySchema = z.object({
  status: z.enum(["PENDING", "SENT", "FAILED", "DELIVERED"]).optional(),
  type: z.enum(["FEE_REMINDER", "PAYMENT_CONFIRMATION", "ACADEMIC", "ADMIN_GENERAL", "PASSWORD_RESET", "CREDENTIALS_ISSUED"]).optional(),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP", "IN_APP"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;
