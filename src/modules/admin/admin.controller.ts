import type { Request, Response } from "express";
import * as service from "./admin.service.js";

export async function getContactGaps(_req: Request, res: Response): Promise<void> {
  res.status(200).json(await service.listContactGaps());
}
