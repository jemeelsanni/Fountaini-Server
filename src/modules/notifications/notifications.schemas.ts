import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const triggerFeeRemindersSchema = z.object({
  academicSessionId: z.string().min(1).optional(),
});
export type TriggerFeeRemindersBody = z.infer<typeof triggerFeeRemindersSchema>;
