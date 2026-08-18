import { z } from "zod";

export const listAuditLogQuerySchema = z.object({
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  actorUserId: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;
