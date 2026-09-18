import { z } from "zod";
import { STAFF_NUMBER_FORMAT } from "../identifiers/identifiers.service.js";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

const staffNumberOverride = z
  .string()
  .regex(STAFF_NUMBER_FORMAT, "Must match FIA/ST<year>/<3-digit sequence>, e.g. FIA/ST2026/001");

export const createStaffSchema = z.object({
  // Optional: server-generated (FIA/ST<year>/<seq>) when omitted — see the
  // report. An explicit value is for importing a staff member who already
  // has a number from the school's paper records; validated for format
  // here and for uniqueness (and registered against the counter) in the
  // service.
  staffNumber: staffNumberOverride.optional(),
  // Staff always gets a login (Staff.userId is non-nullable), created
  // atomically with this record — this replaces the old two-step
  // POST /api/users -> POST /api/staff flow (see the report). One role at
  // creation, same scope limit as POST /api/users always had; granting an
  // additional role to an existing staff member later is unchanged, still
  // out of scope.
  role: z.enum(["ADMIN", "TEACHER", "BURSAR"]),
  // Required: staff must always have one, since credentials are delivered
  // there — unlike a student, there's no "deliver to someone else" fallback.
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  otherNames: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  employmentDate: z.coerce.date().optional(),
});
export type CreateStaffBody = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  staffNumber: staffNumberOverride.optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  otherNames: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  employmentDate: z.coerce.date().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateStaffBody = z.infer<typeof updateStaffSchema>;
