import { Router } from "express";
import { requireAuth, requireRole, requireScope } from "../../authorization/middleware.js";
import { canReadClassRoster } from "../../authorization/scopeResolvers.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { prisma } from "../../db/client.js";
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
  type IdParams,
  type ListClassStudentsQuery,
  listClassStudentsQuerySchema,
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
  auditMutation("AcademicSession", "ACADEMIC_SESSION_SET_CURRENT", {
    fetchBefore: (id) => prisma.academicSession.findUnique({ where: { id } }),
  }),
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
  auditMutation("Term", "TERM_SET_CURRENT", {
    fetchBefore: (id) => prisma.term.findUnique({ where: { id } }),
  }),
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
// Not parents — a parent seeing every child in their child's class is a
// privacy decision nobody has made. requireRole gates out STUDENT/PARENT
// entirely before the scope check ever runs, same split as every other
// role+scope route in this codebase.
academicStructureRouter.get(
  "/classes/:id/students",
  requireRole("ADMIN", "BURSAR", "TEACHER"),
  validate({ params: idParamsSchema, query: listClassStudentsQuerySchema }),
  requireScope((principal, req) => {
    const { id } = req.params as unknown as IdParams;
    const { academicSessionId } = req.query as unknown as ListClassStudentsQuery;
    return canReadClassRoster(principal, id, academicSessionId);
  }),
  controller.listClassStudents,
);

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
