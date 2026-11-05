import type { Request, Response } from "express";
import * as service from "./subject-templates.service.js";
import type { IdParams, SubjectTemplateInput } from "./subject-templates.schemas.js";

export async function listSubjectTemplates(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listSubjectTemplates());
}

export async function createSubjectTemplate(req: Request, res: Response): Promise<void> {
  const template = await service.createSubjectTemplate(req.body as SubjectTemplateInput);
  res.status(201).json(template);
}

export async function updateSubjectTemplate(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.updateSubjectTemplate(id, req.body as SubjectTemplateInput));
}

export async function deleteSubjectTemplate(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  await service.deleteSubjectTemplate(id);
  res.status(204).send();
}
