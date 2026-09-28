import { Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import * as controller from "./admin.controller.js";

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole("ADMIN", "BURSAR"));

adminRouter.get("/contact-gaps", controller.getContactGaps);
