import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./attendance.controller.js";
import {
  classAttendanceQuerySchema,
  correctAttendanceSchema,
  idParamsSchema,
  type IdParams,
  openSessionSchema,
  scanSchema,
} from "./attendance.schemas.js";

export const attendanceRouter = Router();

attendanceRouter.use(requireAuth);

attendanceRouter.post(
  "/attendance-sessions",
  requireRole("ADMIN", "TEACHER"),
  validate({ body: openSessionSchema }),
  controller.openSession,
);
attendanceRouter.post(
  "/attendance-sessions/:id/scan",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: scanSchema }),
  controller.scan,
);
attendanceRouter.post(
  "/attendance-sessions/:id/close",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema }),
  controller.closeSession,
);
attendanceRouter.patch(
  "/attendance-records/:id",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, body: correctAttendanceSchema }),
  auditMutation("AttendanceRecord", "ATTENDANCE_CORRECTED"),
  controller.correctRecord,
);
attendanceRouter.get(
  "/students/:id/attendance",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStudent(principal, (req.params as unknown as IdParams).id)),
  controller.getAttendanceForStudent,
);
attendanceRouter.get(
  "/classes/:id/attendance",
  requireRole("ADMIN", "TEACHER"),
  validate({ params: idParamsSchema, query: classAttendanceQuerySchema }),
  controller.getAttendanceForClass,
);
attendanceRouter.post(
  "/students/:id/qr-code/rotate",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("StudentQrCode", "QR_CODE_ROTATED"),
  controller.rotateQrCode,
);
attendanceRouter.get(
  "/students/:id/qr-code",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  controller.getActiveQrCode,
);
