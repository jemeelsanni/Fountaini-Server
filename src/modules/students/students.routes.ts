import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadStudent } from "../../authorization/scopeResolvers.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./students.controller.js";
import {
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
studentsRouter.get(
  "/:id",
  validate({ params: idParamsSchema }),
  scopeToStudentParam,
  controller.getStudent,
);
studentsRouter.patch(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: updateStudentSchema }),
  auditMutation("Student", "STUDENT_UPDATED"),
  controller.updateStudent,
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
