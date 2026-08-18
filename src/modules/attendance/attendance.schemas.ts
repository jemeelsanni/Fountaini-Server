import { z } from "zod";

export const idParamsSchema = z.object({ id: z.string().min(1) });
export type IdParams = z.infer<typeof idParamsSchema>;

export const openSessionSchema = z.object({
  classId: z.string().min(1),
  academicSessionId: z.string().min(1),
  termId: z.string().min(1),
  date: z.coerce.date().optional(),
});
export type OpenSessionBody = z.infer<typeof openSessionSchema>;

export const scanSchema = z.object({
  code: z.string().min(1),
  late: z.boolean().optional(),
});
export type ScanBody = z.infer<typeof scanSchema>;

export const correctAttendanceSchema = z.object({
  status: z.enum(["PRESENT", "ABSENT", "LATE"]),
  reason: z.string().min(5, "A reason is required when correcting an attendance record"),
});
export type CorrectAttendanceBody = z.infer<typeof correctAttendanceSchema>;

export const classAttendanceQuerySchema = z.object({
  date: z.coerce.date().optional(),
});
export type ClassAttendanceQuery = z.infer<typeof classAttendanceQuerySchema>;
