import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./audit.controller.js";
import { listAuditLogQuerySchema } from "./audit.schemas.js";

export const auditRouter = Router();

auditRouter.use(requireAuth, requireRole("ADMIN"));

auditRouter.get("/", validate({ query: listAuditLogQuerySchema }), controller.listAuditLog);
