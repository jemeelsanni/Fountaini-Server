import { z } from "zod";

export const createUserSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  role: z.enum(["ADMIN", "TEACHER", "PARENT", "STUDENT", "BURSAR"]),
});
export type CreateUserBody = z.infer<typeof createUserSchema>;

export const userIdParamsSchema = z.object({
  id: z.string().min(1),
});
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
