import express, { type NextFunction, type Request, type Response, Router } from "express";
import { requireAuth, requireRole } from "../../authorization/middleware.js";
import { ALL_ROLES } from "../../authorization/types.js";
import { AppError } from "../../errors/AppError.js";
import { auditMutation } from "../../http/middleware/auditMutation.js";
import { validate } from "../../http/middleware/validate.js";
import * as controller from "./school.controller.js";
import { createSchoolSchema, setHeadSignatureSchema, updateSchoolSchema } from "./school.schemas.js";

export const schoolRouter = Router();

schoolRouter.use(requireAuth);

// Every authenticated role, not just ADMIN — the response is the school's
// own name/address/contact info plus createdAt/updatedAt/
// currentAcademicSessionId (an internal FK nothing else in this codebase
// reads — see school.schemas.ts's own comment). None of that is anything a
// parent or student shouldn't see, so there's no need for a separate
// public projection here.
schoolRouter.get("/", requireRole(...ALL_ROLES), controller.getSchool);
// The signature image on its own, so GET / stays small — same audience,
// since every role prints report cards (parents and students their child's).
schoolRouter.get("/signature", requireRole(...ALL_ROLES), controller.getHeadSignature);
schoolRouter.post(
  "/",
  requireRole("ADMIN"),
  validate({ body: createSchoolSchema }),
  auditMutation("School", "SCHOOL_CREATED"),
  controller.createSchool,
);
schoolRouter.patch(
  "/",
  requireRole("ADMIN"),
  validate({ body: updateSchoolSchema }),
  auditMutation("School", "SCHOOL_UPDATED"),
  controller.updateSchool,
);

/// The one route allowed a body over the app-wide 100 KB JSON limit: a
/// 2 MB image is ~2.7 MB as base64. app.ts's global parser skips exactly
/// this path (SCHOOL_SIGNATURE_PATH) so this one can read it. Parser errors
/// are mapped to readable 400s here — left alone they'd reach app.ts's
/// generic 500.
const signatureJson = express.json({ limit: "3mb" });
function parseSignatureBody(req: Request, res: Response, next: NextFunction): void {
  signatureJson(req, res, (err?: unknown) => {
    if (!err) {
      next();
      return;
    }
    const type = (err as { type?: string }).type;
    next(
      type === "entity.too.large"
        ? AppError.badRequest("Signature image is too large (max 2 MB)")
        : AppError.badRequest("Request body must be valid JSON: { \"dataUrl\": \"data:image/png;base64,…\" }"),
    );
  });
}

// Audited like PATCH /. The responses carry hasHeadSignature, not the image,
// and auditMutation would summarize headSignature to "[set]"/null anyway.
schoolRouter.put(
  "/signature",
  requireRole("ADMIN"),
  parseSignatureBody,
  validate({ body: setHeadSignatureSchema }),
  auditMutation("School", "SCHOOL_SIGNATURE_SET"),
  controller.setHeadSignature,
);
schoolRouter.delete(
  "/signature",
  requireRole("ADMIN"),
  auditMutation("School", "SCHOOL_SIGNATURE_CLEARED"),
  controller.clearHeadSignature,
);
