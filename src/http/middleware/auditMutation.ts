import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { writeAuditLog } from "../../modules/audit/audit.service.js";

/// Field names never persisted into AuditLog.afterData, even though the
/// client legitimately receives them in the response — a one-time
/// generated credential (see students.service.ts/staff.service.ts/
/// users.service.ts's createStudent/createStaff/createUser, and
/// scoreForAssignment's... no, just the credential-issuing paths) would
/// otherwise land in a permanent, plaintext DB row readable via
/// GET /api/audit-log. Redacted by omission, not a "[REDACTED]"
/// placeholder — the audit trail's job is recording who created what, not
/// whether a secret happened to be issued.
const REDACTED_RESPONSE_FIELDS: ReadonlySet<string> = new Set(["temporaryPassword"]);

function redact(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const field of REDACTED_RESPONSE_FIELDS) {
    delete out[field];
  }
  return out;
}

/// Declarative audit logging for admin/bursar mutation routes — one line at
/// route-registration time instead of a writeAuditLog() call threaded through
/// every service function. Captures whatever the route responds with (works
/// for both res.json(created) on 2xx-with-body and res.status(204).send() —
/// falls back to req.params.id when there's no body to read an id from) and
/// fires the write after the response is already on the wire, so a slow or
/// failing audit write never delays or breaks the actual request.
export function auditMutation(entityType: string, action: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let capturedBody: unknown;

    const originalJson = res.json.bind(res);
    res.json = (body?: unknown) => {
      capturedBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || !req.principal) {
        return;
      }

      const bodyRecord =
        capturedBody && typeof capturedBody === "object"
          ? (capturedBody as Record<string, unknown>)
          : undefined;
      const idFromBody = typeof bodyRecord?.id === "string" ? bodyRecord.id : undefined;
      const idFromParams = typeof req.params.id === "string" ? req.params.id : undefined;

      fireAndForget(
        writeAuditLog({
          actorUserId: req.principal.userId,
          actorRoles: [...req.principal.roles],
          action,
          entityType,
          entityId: idFromParams ?? idFromBody ?? "unknown",
          afterData: bodyRecord ? (redact(bodyRecord) as Prisma.InputJsonValue) : undefined,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        }),
        (err) => logger.error({ err }, "Failed to write audit log"),
      );
    });

    next();
  };
}
