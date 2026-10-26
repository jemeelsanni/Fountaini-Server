import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

/// academicSessionId defaults to the current session (see
/// id-cards.service.ts's listStudentIdCards) — a class's cards are almost
/// always printed for the session it's in now.
export const listStudentIdCardsQuerySchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1).optional(),
});
export type ListStudentIdCardsQuery = z.infer<typeof listStudentIdCardsQuerySchema>;
