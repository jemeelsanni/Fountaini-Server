import { z } from "zod";

// Narrowed to ADMIN only — every other role now has its own atomic
// creation path: STUDENT via POST /api/students (credentials issued on
// primary-contact parent link), TEACHER/BURSAR/ADMIN-with-a-staff-record
// via POST /api/staff, and PARENT via POST /api/parents. All three create
// the User and its linked profile record together, in one transaction,
// with loginId/credential generation resolved at that same time. What's
// left for this route is the one account type that legitimately has no
// profile record of its own: a bare ADMIN bootstrap account.
export const createUserSchema = z.object({
  email: z.email(),
  role: z.literal("ADMIN"),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
