import type { NextFunction, Request, Response } from "express";
import type { Prisma } from "../../../generated/prisma/index.js";
import { logger } from "../../config/logger.js";
import { fireAndForget } from "../../lib/fireAndForget.js";
import { writeAuditLog } from "../../modules/audit/audit.service.js";

/// Field names never persisted into AuditLog.beforeData or afterData, even
/// though a client may legitimately receive them (temporaryPassword, in a
/// create/reissue response) or a fetchBefore read may legitimately need
/// them internally (passwordHash, to compare against on login). Redacted by
/// omission, not a "[REDACTED]" placeholder — the audit trail's job is
/// recording who changed what, not whether a secret happened to be issued
/// or exist. passwordHash specifically only matters here because of
/// fetchBefore: every existing afterData source (a controller's res.json)
/// already goes through a response shape that never includes it (e.g.
/// users.service.ts's userListSelect) — a raw fetchBefore read is the first
/// path in this codebase that can put a full, unprojected User row in
/// front of this function, so it's the first place that actually needs
/// this entry to do anything.
const REDACTED_RESPONSE_FIELDS: ReadonlySet<string> = new Set(["temporaryPassword", "passwordHash"]);

function redact(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const field of REDACTED_RESPONSE_FIELDS) {
    delete out[field];
  }
  return out;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export interface AuditMutationOptions {
  /// Reads the entity's pre-mutation state, keyed by req.params.id — called
  /// and awaited BEFORE the route handler runs, since the whole point is
  /// capturing what the row looked like before the handler's write. This is
  /// the one part of auditing that can't be fire-and-forget: fire-and-forget
  /// is safe for the WRITE (nothing downstream depends on when it lands),
  /// but a "before" read that ran after the mutation wouldn't be a "before"
  /// at all.
  ///
  /// Opt-in per route, not automatic from entityType, because req.params.id
  /// doesn't always name the entity being mutated: a bulk-mutation route
  /// (e.g. POST /api/classes/:id/results/:termId/rank) has no single row's
  /// id to key on at all, and a nested-collection create (e.g.
  /// POST /api/parents/:id/children) has :id naming the PARENT, not the
  /// (not-yet-existing, so before-less anyway) thing being created. Routes
  /// like those simply never pass this option.
  ///
  /// A throwing fetchBefore must never fail the mutation it's only supposed
  /// to be documenting — caught and logged, and the write proceeds with
  /// beforeData: undefined, same posture as a failed audit WRITE never
  /// failing the request that triggered it.
  fetchBefore?: (id: string) => Promise<unknown>;
}

/// Declarative audit logging for admin/bursar mutation routes — one line at
/// route-registration time instead of a writeAuditLog() call threaded through
/// every service function. Captures whatever the route responds with (works
/// for both res.json(created) on 2xx-with-body and res.status(204).send() —
/// falls back to req.params.id when there's no body to read an id from) and
/// fires the write after the response is already on the wire, so a slow or
/// failing audit write never delays or breaks the actual request.
export function auditMutation(entityType: string, action: string, options: AuditMutationOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let capturedBody: unknown;
    let beforeData: unknown;

    const originalJson = res.json.bind(res);
    res.json = (body?: unknown) => {
      capturedBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || !req.principal) {
        return;
      }

      const bodyRecord = toRecord(capturedBody);
      const beforeRecord = toRecord(beforeData);
      const idFromBody = typeof bodyRecord?.id === "string" ? bodyRecord.id : undefined;
      const idFromParams = typeof req.params.id === "string" ? req.params.id : undefined;

      fireAndForget(
        writeAuditLog({
          actorUserId: req.principal.userId,
          actorRoles: [...req.principal.roles],
          action,
          entityType,
          entityId: idFromParams ?? idFromBody ?? "unknown",
          beforeData: beforeRecord ? (redact(beforeRecord) as Prisma.InputJsonValue) : undefined,
          afterData: bodyRecord ? (redact(bodyRecord) as Prisma.InputJsonValue) : undefined,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        }),
        (err) => logger.error({ err }, "Failed to write audit log"),
      );
    });

    const id = req.params.id;
    if (!options.fetchBefore || typeof id !== "string") {
      next();
      return;
    }

    options.fetchBefore(id).then(
      (value) => {
        beforeData = value;
        next();
      },
      (err: unknown) => {
        logger.error({ err, entityType, action, id }, "auditMutation's fetchBefore failed — continuing without beforeData");
        next();
      },
    );
  };
}
