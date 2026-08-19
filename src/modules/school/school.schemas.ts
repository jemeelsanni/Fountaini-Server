import { z } from "zod";

// currentAcademicSessionId is deliberately not exposed here: it exists on
// the School model but nothing in this codebase actually reads it — "the
// current academic session" is already a fully working, independently
// enforced concept via AcademicSession.isCurrent (a partial unique index,
// set through POST /api/academic-sessions/:id/set-current). Wiring up a
// second, parallel "current session" pointer on School that nothing else
// consults would be confusing to have, not useful.
export const createSchoolSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1).optional(),
  contactEmail: z.email().optional(),
  contactPhone: z.string().min(1).optional(),
});
export type CreateSchoolBody = z.infer<typeof createSchoolSchema>;

export const updateSchoolSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().min(1).optional(),
  contactEmail: z.email().optional(),
  contactPhone: z.string().min(1).optional(),
});
export type UpdateSchoolBody = z.infer<typeof updateSchoolSchema>;
