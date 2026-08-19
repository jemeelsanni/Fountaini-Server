import type { Request, Response } from "express";
import * as service from "./school.service.js";
import type { CreateSchoolBody, UpdateSchoolBody } from "./school.schemas.js";

export async function getSchool(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.getSchool());
}

export async function createSchool(req: Request, res: Response): Promise<void> {
  const school = await service.createSchool(req.body as CreateSchoolBody);
  res.status(201).json(school);
}

export async function updateSchool(req: Request, res: Response): Promise<void> {
  const school = await service.updateSchool(req.body as UpdateSchoolBody);
  res.status(200).json(school);
}
