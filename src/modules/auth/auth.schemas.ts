import { z } from "zod";

// `identifier` deliberately replaces `email` outright rather than accepting
// both — a clean break, not a backwards-compatible union, since the
// frontend isn't live yet (see the report). It's a loginId (admission
// number, staff number) or an email — login() resolves whichever it is
// without branching on role.
export const loginSchema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

// Same identifier-not-email shape as login — admission numbers are
// sequential and guessable (see requestPasswordReset's own comment), which
// is exactly why this endpoint's generic response and rate limit matter.
export const requestPasswordResetSchema = z.object({
  identifier: z.string().min(1),
});
export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
