import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadClassTimetable, canReadStaff } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./timetable.controller.js";
import {
  createTimeSlotSchema,
  createTimetableEntrySchema,
  idParamsSchema,
  type IdParams,
} from "./timetable.schemas.js";

export const timetableRouter = Router();

timetableRouter.use(requireAuth);

timetableRouter.post(
  "/time-slots",
  requireRole("ADMIN"),
  validate({ body: createTimeSlotSchema }),
  auditMutation("TimeSlot", "TIME_SLOT_CREATED"),
  controller.createTimeSlot,
);
timetableRouter.get("/time-slots", requireRole(...ALL_ROLES), controller.listTimeSlots);

timetableRouter.post(
  "/timetable-entries",
  requireRole("ADMIN"),
  validate({ body: createTimetableEntrySchema }),
  auditMutation("TimetableEntry", "TIMETABLE_ENTRY_CREATED"),
  controller.createTimetableEntry,
);
timetableRouter.delete(
  "/timetable-entries/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("TimetableEntry", "TIMETABLE_ENTRY_DELETED"),
  controller.deleteTimetableEntry,
);

timetableRouter.get(
  "/classes/:id/timetable",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadClassTimetable(principal, (req.params as unknown as IdParams).id)),
  controller.getTimetableForClass,
);
timetableRouter.get(
  "/staff/:id/timetable",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStaff(principal, (req.params as unknown as IdParams).id)),
  controller.getTimetableForTeacher,
);
