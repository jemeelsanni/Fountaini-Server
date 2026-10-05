import { z } from "zod";

// z.email() validates format BEFORE any chained .trim() would run (a
// leading/trailing space fails the format check outright, confirmed
// directly against this Zod version) — .trim() has to come first in the
// chain, piped into the format check on the already-trimmed value, so a
// pasted trailing space doesn't produce a confusing 400 for an address
// normalizeEmail() (auth/loginIdentifier.ts) would otherwise have happily
// cleaned up. Lowercasing stays in normalizeEmail() alone, at the service
// layer — no need to duplicate that half here too.
const trimmedEmail = z.string().trim().pipe(z.email());

// Narrowed to ADMIN only — every other role now has its own atomic
// creation path: STUDENT via POST /api/students (credentials issued on
// primary-contact parent link), TEACHER/BURSAR/ADMIN-with-a-staff-record
// via POST /api/staff, and PARENT via POST /api/parents. All three create
// the User and its linked profile record together, in one transaction,
// with loginId/credential generation resolved at that same time. What's
// left for this route is the one account type that legitimately has no
// profile record of its own: a bare ADMIN bootstrap account.
export const createUserSchema = z.object({
  email: trimmedEmail,
  role: z.literal("ADMIN"),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;

export const updateUserEmailSchema = z.object({
  email: trimmedEmail,
});
export type UpdateUserEmailBody = z.infer<typeof updateUserEmailSchema>;
