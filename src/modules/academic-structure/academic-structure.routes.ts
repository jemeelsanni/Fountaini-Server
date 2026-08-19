import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./academic-structure.controller.js";
import {
  createAcademicSessionSchema,
  createClassFormTeacherSchema,
  createClassSchema,
  createClassSubjectAssignmentSchema,
  createSubjectSchema,
  createTermSchema,
  idParamsSchema,
} from "./academic-structure.schemas.js";

export const academicStructureRouter = Router();

academicStructureRouter.use(requireAuth);

academicStructureRouter.post(
  "/academic-sessions",
  requireRole("ADMIN"),
  validate({ body: createAcademicSessionSchema }),
  auditMutation("AcademicSession", "ACADEMIC_SESSION_CREATED"),
  controller.createAcademicSession,
);
academicStructureRouter.get(
  "/academic-sessions",
  requireRole(...ALL_ROLES),
  controller.listAcademicSessions,
);
academicStructureRouter.patch(
  "/academic-sessions/:id/set-current",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("AcademicSession", "ACADEMIC_SESSION_SET_CURRENT"),
  controller.setCurrentAcademicSession,
);
academicStructureRouter.post(
  "/academic-sessions/:id/terms",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: createTermSchema }),
  auditMutation("Term", "TERM_CREATED"),
  controller.createTerm,
);
academicStructureRouter.get(
  "/academic-sessions/:id/terms",
  requireRole(...ALL_ROLES),
  validate({ params: idParamsSchema }),
  controller.listTermsForSession,
);
academicStructureRouter.patch(
  "/terms/:id/set-current",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("Term", "TERM_SET_CURRENT"),
  controller.setCurrentTerm,
);

academicStructureRouter.post(
  "/classes",
  requireRole("ADMIN"),
  validate({ body: createClassSchema }),
  auditMutation("Class", "CLASS_CREATED"),
  controller.createClass,
);
academicStructureRouter.get("/classes", requireRole(...ALL_ROLES), controller.listClasses);

academicStructureRouter.post(
  "/subjects",
  requireRole("ADMIN"),
  validate({ body: createSubjectSchema }),
  auditMutation("Subject", "SUBJECT_CREATED"),
  controller.createSubject,
);
academicStructureRouter.get("/subjects", requireRole(...ALL_ROLES), controller.listSubjects);

academicStructureRouter.post(
  "/class-subject-assignments",
  requireRole("ADMIN"),
  validate({ body: createClassSubjectAssignmentSchema }),
  auditMutation("ClassSubjectAssignment", "ASSIGNMENT_CREATED"),
  controller.createClassSubjectAssignment,
);
academicStructureRouter.get(
  "/class-subject-assignments",
  requireRole("ADMIN", "TEACHER"),
  controller.listClassSubjectAssignments,
);
academicStructureRouter.delete(
  "/class-subject-assignments/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("ClassSubjectAssignment", "ASSIGNMENT_DELETED"),
  controller.deleteClassSubjectAssignment,
);

academicStructureRouter.post(
  "/class-form-teachers",
  requireRole("ADMIN"),
  validate({ body: createClassFormTeacherSchema }),
  auditMutation("ClassFormTeacher", "FORM_TEACHER_ASSIGNED"),
  controller.createClassFormTeacher,
);
academicStructureRouter.get(
  "/class-form-teachers",
  requireRole("ADMIN", "TEACHER"),
  controller.listClassFormTeachers,
);
academicStructureRouter.delete(
  "/class-form-teachers/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("ClassFormTeacher", "FORM_TEACHER_UNASSIGNED"),
  controller.deleteClassFormTeacher,
);
