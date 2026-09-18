import type { NextFunction, Request, Response } from "express";
import type { Role } from "../../generated/prisma/index.js";
import { prisma } from "../db/client.js";
import { AppError } from "../errors/AppError.js";
import { verifyAccessToken } from "../modules/auth/jwt.js";
import type { Principal } from "./types.js";

/// The only two routes reachable while mustChangePassword is true — a
/// caller has to be able to see who they are and change their password
/// before anything else works. Checked against req.originalUrl (the full,
/// un-rewritten path, unaffected by which router's .use(requireAuth)
/// actually ran this) rather than req.path, which is relative to whichever
/// router is currently executing and would collide with an unrelated
/// same-named path in a different module.
export const MUST_CHANGE_PASSWORD_EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/auth/me",
  "POST /api/auth/change-password",
]);

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
///
/// Also enforces mustChangePassword, in this one shared layer rather than
/// per-route, exactly like the instruction that added it asked for. This is
/// deliberately a live DB read on every authenticated request rather than a
/// claim embedded in the access token (the way roles/staffId/etc. are): the
/// whole point of this gate is "change your password, then immediately
/// proceed" within ONE session's still-valid access token — an
/// isActive-style "enforced at next login/refresh" would leave the very
/// request right after a successful change-password still blocked by a
/// stale token claim, which defeats it.
async function requireAuthHandler(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    next(AppError.unauthorized("Missing or invalid Authorization header"));
    return;
  }

  const token = header.slice("Bearer ".length);

  let principal: Principal;
  try {
    const payload = verifyAccessToken(token);
    principal = {
      userId: payload.sub,
      roles: new Set(payload.roles),
      staffId: payload.staffId,
      parentId: payload.parentId,
      studentId: payload.studentId,
    };
  } catch {
    next(AppError.unauthorized("Invalid or expired access token"));
    return;
  }

  const routeKey = `${req.method} ${req.originalUrl.split("?")[0]}`;
  if (!MUST_CHANGE_PASSWORD_EXEMPT_ROUTES.has(routeKey)) {
    const user = await prisma.user.findUnique({
      where: { id: principal.userId },
      select: { mustChangePassword: true },
    });
    if (user?.mustChangePassword) {
      next(AppError.mustChangePassword());
      return;
    }
  }

  req.principal = principal;
  next();
}
export const requireAuth: GuardedHandler = tagGuard(
  (req: Request, res: Response, next: NextFunction): void => {
    requireAuthHandler(req, res, next).catch(next);
  },
  "auth",
);

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
