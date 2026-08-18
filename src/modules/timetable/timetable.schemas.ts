import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be in HH:mm 24-hour format");

export const createTimeSlotSchema = z.object({
  name: z.string().min(1),
  startTime: hhmm,
  endTime: hhmm,
  order: z.coerce.number().int().nonnegative(),
});
export type CreateTimeSlotBody = z.infer<typeof createTimeSlotSchema>;

export const createTimetableEntrySchema = z.object({
  classSubjectAssignmentId: z.string().min(1),
  timeSlotId: z.string().min(1),
  dayOfWeek: z.enum(["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"]),
});
export type CreateTimetableEntryBody = z.infer<typeof createTimetableEntrySchema>;
