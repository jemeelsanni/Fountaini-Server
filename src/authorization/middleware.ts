import type { NextFunction, Request, Response } from "express";
import type { Role } from "../../generated/prisma/index.js";
import { AppError } from "../errors/AppError.js";
import { verifyAccessToken } from "../modules/auth/jwt.js";
import type { Principal } from "./types.js";

/// Tag applied to every guard middleware so the route-guard inventory test
/// can identify "is this an auth guard" at runtime without relying on
/// function.name — requireRole/requireScope return anonymous closures, which
/// are otherwise indistinguishable from validate()/auditMutation()'s own
/// anonymous closures once registered on a route.
export type GuardType = "auth" | "role" | "scope";

type Handler = (req: Request, res: Response, next: NextFunction) => void;

export interface GuardedHandler extends Handler {
  guardType: GuardType;
  roles?: readonly Role[];
}

function tagGuard(fn: Handler, guardType: GuardType, roles?: readonly Role[]): GuardedHandler {
  const tagged = fn as GuardedHandler;
  tagged.guardType = guardType;
  if (roles) {
    tagged.roles = roles;
  }
  return tagged;
}

/// Verifies the access token and attaches a Principal to the request. Every
/// route that needs identity — role-only or data-scoped — starts here.
function requireAuthHandler(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(AppError.unauthorized("Missing or invalid Authorization header"));
    return;
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = verifyAccessToken(token);
    const principal: Principal = {
      userId: payload.sub,
      roles: new Set(payload.roles),
      staffId: payload.staffId,
      parentId: payload.parentId,
      studentId: payload.studentId,
    };
    req.principal = principal;
    next();
  } catch {
    next(AppError.unauthorized("Invalid or expired access token"));
  }
}
export const requireAuth: GuardedHandler = tagGuard(requireAuthHandler, "auth");

/// Pure role allowlist — no data ownership involved.
export function requireRole(...roles: Role[]): GuardedHandler {
  return tagGuard(
    (req: Request, _res: Response, next: NextFunction): void => {
      const { principal } = req;
      if (!principal) {
        next(AppError.unauthorized());
        return;
      }
      if (!roles.some((r) => principal.roles.has(r))) {
        next(AppError.forbidden("You do not have permission to perform this action"));
        return;
      }
      next();
    },
    "role",
    roles,
  );
}

/// Data-scoped authorization: the single place ownership checks happen,
/// instead of scattered `if (parent) ...` branches in controllers. Resolvers
/// live in ./scopeResolvers.ts and decide ownership via the real relationship
/// tables (StudentParent, ClassSubjectAssignment + Enrollment, etc).
export function requireScope(
  resolver: (principal: Principal, req: Request) => Promise<boolean>,
): GuardedHandler {
  return tagGuard((req: Request, _res: Response, next: NextFunction): void => {
    if (!req.principal) {
      next(AppError.unauthorized());
      return;
    }

    resolver(req.principal, req)
      .then((allowed) => {
        if (!allowed) {
          next(AppError.forbidden("You do not have access to this resource"));
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        next(err);
      });
  }, "scope");
}
