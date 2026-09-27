import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent, canReadStudentParents } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./students.controller.js";
import {
  bulkUpdateStudentStatusSchema,
  createEnrollmentSchema,
  createStudentSchema,
  idParamsSchema,
  type IdParams,
  updateStudentSchema,
} from "./students.schemas.js";

export const studentsRouter = Router();

studentsRouter.use(requireAuth);

const scopeToStudentParam = requireScope((principal, req) =>
  canReadStudent(principal, (req.params as unknown as IdParams).id),
);

studentsRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: createStudentSchema }),
  auditMutation("Student", "STUDENT_CREATED"),
  controller.createStudent,
);
studentsRouter.get("/", requireRole("ADMIN"), controller.listStudents);
// Registered before "/:id" or Express would match "status" as :id.
// GRADUATED/WITHDRAWN also close each student's active enrollment(s) — see
// ENROLLMENT_CLOSING_STATUS (students.service.ts). INACTIVE is a label
// only: it does NOT end enrollment, does not remove the student from any
// class roster or score sheet, and does not stop billing. WITHDRAWN is the
// status that does all of that. Partial success: a 200 response always
// carries { updated, failed } rather than 4xx/5xx-ing the whole batch over
// one bad id.
studentsRouter.patch(
  "/status",
  requireRole("ADMIN"),
  validate({ body: bulkUpdateStudentStatusSchema }),
  auditMutation("Student", "STUDENT_STATUS_BULK_UPDATED"),
  controller.bulkUpdateStatus,
);
studentsRouter.get(
  "/:id",
  validate({ params: idParamsSchema }),
  scopeToStudentParam,
  controller.getStudent,
);
// Setting status to GRADUATED or WITHDRAWN here also closes this student's
// active enrollment(s) — same behavior, same reasoning, as
// PATCH /api/students/status (see that route's own comment on why INACTIVE
// deliberately does not).
studentsRouter.patch(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateStudentSchema }),
  auditMutation("Student", "STUDENT_UPDATED"),
  controller.updateStudent,
);
// Recovery path: a student with a login but nowhere left to deliver a
// fresh one to (see reissueCredentialsForStudent's own comment) still
// returns 200 with temporaryPassword in the body — auditMutation's
// existing redaction (http/middleware/auditMutation.ts) keeps that one
// field out of the permanent audit log either way.
studentsRouter.post(
  "/:id/reissue-credentials",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Student", "STUDENT_CREDENTIALS_REISSUED"),
  controller.reissueCredentials,
);
studentsRouter.post(
  "/:id/enrollments",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createEnrollmentSchema }),
  auditMutation("Enrollment", "ENROLLMENT_CREATED"),
  controller.createEnrollment,
);
studentsRouter.get(
  "/:id/enrollments",
  validate({ params: idParamsSchema }),
  scopeToStudentParam,
  controller.listEnrollments,
);
studentsRouter.get(
  "/:id/parents",
  validate({ params: idParamsSchema }),
  requireScope((principal, req) => canReadStudentParents(principal, (req.params as unknown as IdParams).id)),
  controller.listParents,
);
