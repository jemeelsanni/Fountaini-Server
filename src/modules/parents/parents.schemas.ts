import { z } from "zod";
import { phoneSchema } from "../../lib/phone.js";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const parentChildParamsSchema = z.object({
  id: z.string().min(1),
  studentId: z.string().min(1),
});
export type ParentChildParams = z.infer<typeof parentChildParamsSchema>;

// Atomic, same shape as createStaffSchema: the User (loginId = email,
// generated password, mustChangePassword: true) and the Parent profile are
// created together — there is no separate POST /api/users step anymore, so
// there's no window where a PARENT-role account exists without its Parent
// record (see auth.service.ts's buildAccessTokenPayload for the boundary
// check on that invariant).
export const createParentSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: phoneSchema.optional(),
  alternatePhone: phoneSchema.optional(),
  address: z.string().min(1).optional(),
});
export type CreateParentBody = z.infer<typeof createParentSchema>;

// firstName/lastName stay non-nullable (the Parent model requires both) —
// only .optional(), so an absent key leaves the field untouched and there's
// no way to null them out. phone/alternatePhone/address are nullable on the
// model, so each is .nullable().optional(): an absent key parses to
// undefined (Prisma's update() treats an undefined field as "don't touch"),
// an explicit null parses to literal null (Prisma sets the column to NULL) —
// the two are never conflated because .optional() alone would only ever
// produce undefined, never null, for a JSON body. Email/loginId is
// deliberately not here — see parents.routes.ts's route comment.
export const updateParentSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: phoneSchema.nullable().optional(),
  alternatePhone: phoneSchema.nullable().optional(),
  address: z.string().min(1).nullable().optional(),
});
export type UpdateParentBody = z.infer<typeof updateParentSchema>;

export const linkChildSchema = z.object({
  studentId: z.string().min(1),
  relationship: z.enum(["FATHER", "MOTHER", "GUARDIAN", "OTHER"]),
  isPrimaryContact: z.boolean().optional(),
});
export type LinkChildBody = z.infer<typeof linkChildSchema>;
