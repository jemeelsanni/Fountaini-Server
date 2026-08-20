import cors from "cors";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import "./authorization/types.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { prisma } from "./db/client.js";
import { AppError } from "./errors/AppError.js";
import { academicStructureRouter } from "./modules/academic-structure/academic-structure.routes.js";
import { admissionsRouter } from "./modules/admissions/admissions.routes.js";
import { attendanceRouter } from "./modules/attendance/attendance.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { feesRouter } from "./modules/fees/fees.routes.js";
import { gradingRouter } from "./modules/grading/grading.routes.js";
import { madrassahRouter } from "./modules/madrassah/madrassah.routes.js";
import { notificationsRouter } from "./modules/notifications/notifications.routes.js";
import { parentsRouter } from "./modules/parents/parents.routes.js";
import { resultsRouter } from "./modules/results/results.routes.js";
import { schoolRouter } from "./modules/school/school.routes.js";
import { scoresRouter } from "./modules/scores/scores.routes.js";
import { staffRouter } from "./modules/staff/staff.routes.js";
import { studentsRouter } from "./modules/students/students.routes.js";
import { timetableRouter } from "./modules/timetable/timetable.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";
import { mountOpenApiRoutes } from "./openapi/openapi.routes.js";

export interface RouteMount {
  prefix: string;
  router: Router;
}

/// Single source of truth for prefix -> router mounting, consumed by both
/// createApp() and the route-guard inventory test — so the test walks
/// exactly what's actually mounted, in exactly the order it's mounted in,
/// with no separate list to fall out of sync.
export const routeMounts: RouteMount[] = [
  { prefix: "/api/auth", router: authRouter },
  { prefix: "/api/users", router: usersRouter },
  { prefix: "/api/students", router: studentsRouter },
  { prefix: "/api/parents", router: parentsRouter },
  { prefix: "/api/staff", router: staffRouter },
  { prefix: "/api/audit-log", router: auditRouter },
  { prefix: "/api/school", router: schoolRouter },
  // admissionsRouter must be mounted before any other router sharing the bare
  // "/api" prefix: it's the only one with a public route, and every other
  // router below applies requireAuth as a blanket router.use() with no path —
  // which, per Express semantics, matches ANY request reaching that mount
  // point, not just routes defined in that file. Mounted first, admissions'
  // own (per-route, not blanket) auth gets first refusal on its own paths,
  // and everything else correctly falls through to the routers below.
  { prefix: "/api", router: admissionsRouter },
  { prefix: "/api", router: academicStructureRouter },
  { prefix: "/api", router: gradingRouter },
  { prefix: "/api", router: scoresRouter },
  { prefix: "/api", router: resultsRouter },
  { prefix: "/api", router: attendanceRouter },
  { prefix: "/api", router: feesRouter },
  { prefix: "/api", router: notificationsRouter },
  { prefix: "/api", router: madrassahRouter },
  { prefix: "/api", router: timetableRouter },
];

export function createApp() {
  const app = express();

  // Railway terminates TLS at its edge and proxies to this process over one
  // internal hop — without this, req.ip (and everything derived from it,
  // e.g. every rate limiter below) resolves to the proxy's own address,
  // not the real client's, bucketing every request from every real client
  // as if it came from one IP. `1` means "trust exactly one hop", matching
  // Railway's topology — not `true`, which would trust the whole
  // X-Forwarded-For chain including anything a client itself sent.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header at all (server-to-server calls, curl, same-origin
        // requests) — CORS only governs browser cross-origin behavior, so
        // there's nothing to check against and no reason to block it.
        if (!origin) {
          callback(null, true);
          return;
        }
        // Unset CORS_ORIGINS outside production means "allow anything" —
        // the same wide-open behavior a bare cors() had — env.ts's
        // superRefine guarantees this can't happen in production.
        if (!env.CORS_ORIGINS || env.CORS_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(AppError.forbidden(`Origin ${origin} is not allowed by CORS`));
      },
    }),
  );
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.get("/health", (_req: Request, res: Response) => {
    // A trivial DB round-trip, not just "the process is alive" — Railway's
    // healthcheck target. A process that's up but can't reach Postgres
    // (bad DATABASE_URL, DB not ready yet, connection pool exhausted)
    // should fail healthchecks and be treated as unhealthy, not report OK
    // while every real request 500s.
    prisma
      .$queryRaw`SELECT 1`
      .then(() => {
        res.status(200).json({ status: "ok" });
      })
      .catch((err: unknown) => {
        logger.error({ err }, "Health check DB round-trip failed");
        res.status(503).json({ status: "unavailable" });
      });
  });

  // Registered before every routeMounts router below, for the same reason
  // admissionsRouter must be first among them (see that comment): several
  // of those routers apply requireAuth as a blanket router.use() with no
  // path, which — per Express semantics — matches ANY request reaching
  // that mount point, not just routes defined in that file. These routes
  // are public (see PUBLIC_ROUTES) and must never reach that blanket auth.
  // Gated by DOCS_ENABLED (on by default outside production — see env.ts):
  // the spec publishes `x-roles` for every route, a complete authorization
  // map, not something to leave publicly reachable in production by default.
  mountOpenApiRoutes(app, routeMounts, env.DOCS_ENABLED);

  for (const { prefix, router } of routeMounts) {
    app.use(prefix, router);
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not Found" } });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }

    req.log?.error({ err }, "Unhandled error");
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" } });
  });

  return app;
}
