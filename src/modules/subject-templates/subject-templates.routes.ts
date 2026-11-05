import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { prisma } from "../../db/client.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./subject-templates.controller.js";
import { idParamsSchema, subjectTemplateInputSchema } from "./subject-templates.schemas.js";

export const subjectTemplatesRouter = Router();

subjectTemplatesRouter.use(requireAuth);

const fetchTemplate = (id: string) =>
  prisma.subjectTemplate.findUnique({ where: { id }, include: { subjects: { orderBy: { order: "asc" } } } });

subjectTemplatesRouter.get("/", requireRole("ADMIN"), controller.listSubjectTemplates);
subjectTemplatesRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: subjectTemplateInputSchema }),
  auditMutation("SubjectTemplate", "SUBJECT_TEMPLATE_CREATED"),
  controller.createSubjectTemplate,
);
subjectTemplatesRouter.patch(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema, body: subjectTemplateInputSchema }),
  auditMutation("SubjectTemplate", "SUBJECT_TEMPLATE_UPDATED", { fetchBefore: fetchTemplate }),
  controller.updateSubjectTemplate,
);
subjectTemplatesRouter.delete(
  "/:id",
  requireRole("ADMIN"),
  validate({ params: idParamsSchema }),
  auditMutation("SubjectTemplate", "SUBJECT_TEMPLATE_DELETED", { fetchBefore: fetchTemplate }),
  controller.deleteSubjectTemplate,
);
