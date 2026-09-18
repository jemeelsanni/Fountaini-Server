import { z } from "zod";

// STUDENT and TEACHER/ADMIN/BURSAR-with-a-staff-record are excluded here on
// purpose: every student is created via POST /api/students, and every
// staff-record account via POST /api/staff — both now atomic (User +
// Student/Staff together, loginId derived from the generated number in the
// same transaction; see the report). This route is narrowed to whatever's
// left: PARENT (still two-step — POST /api/users then POST /api/parents —
// since a parent's loginId is just their email, known immediately, with no
// generated-number dependency), and a bare ADMIN/TEACHER/BURSAR account
// that will never get a Staff record of its own.
export const createUserSchema = z.object({
  email: z.email(),
  role: z.enum(["ADMIN", "TEACHER", "PARENT", "BURSAR"]),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
