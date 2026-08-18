import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const parentChildParamsSchema = z.object({
  id: z.string().min(1),
  studentId: z.string().min(1),
});
export type ParentChildParams = z.infer<typeof parentChildParamsSchema>;

export const createParentSchema = z.object({
  userId: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().min(1).optional(),
  alternatePhone: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
});
export type CreateParentBody = z.infer<typeof createParentSchema>;

export const linkChildSchema = z.object({
  studentId: z.string().min(1),
  relationship: z.enum(["FATHER", "MOTHER", "GUARDIAN", "OTHER"]),
  isPrimaryContact: z.boolean().optional(),
});
export type LinkChildBody = z.infer<typeof linkChildSchema>;
