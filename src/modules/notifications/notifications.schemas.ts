import { z } from "zod";

export const triggerFeeRemindersSchema = z.object({
  academicSessionId: z.string().min(1).optional(),
});
export type TriggerFeeRemindersBody = z.infer<typeof triggerFeeRemindersSchema>;
