import type { Request, Response } from "express";
import * as service from "./audit.service.js";
import type { ListAuditLogQuery } from "./audit.schemas.js";

export async function listAuditLog(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAuditLogQuery;
  res.status(200).json(await service.listAuditLog(query));
}
