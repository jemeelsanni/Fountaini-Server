import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError.js";
import * as service from "./parents.service.js";
import type {
  CreateParentBody,
  IdParams,
  LinkChildBody,
  ParentChildParams,
} from "./parents.schemas.js";

export async function createParent(req: Request, res: Response): Promise<void> {
  const parent = await service.createParent(req.body as CreateParentBody);
  res.status(201).json(parent);
}

export async function listParents(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listParents());
}

export async function getParent(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  res.status(200).json(await service.getParentById(id));
}

export async function linkChild(req: Request, res: Response): Promise<void> {
  const { id } = req.params as unknown as IdParams;
  const link = await service.linkChild(id, req.body as LinkChildBody);
  res.status(201).json(link);
}

export async function unlinkChild(req: Request, res: Response): Promise<void> {
  const { id, studentId } = req.params as unknown as ParentChildParams;
  await service.unlinkChild(id, studentId);
  res.status(204).send();
}

export async function listMyChildren(req: Request, res: Response): Promise<void> {
  if (!req.principal?.parentId) {
    throw AppError.forbidden("This account is not linked to a parent profile");
  }
  res.status(200).json(await service.listChildrenForParent(req.principal.parentId));
}
