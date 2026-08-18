import cors from "cors";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import "./authorization/types.js";
import { logger } from "./config/logger.js";
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
import { scoresRouter } from "./modules/scores/scores.routes.js";
import { staffRouter } from "./modules/staff/staff.routes.js";
import { studentsRouter } from "./modules/students/students.routes.js";
import { timetableRouter } from "./modules/timetable/timetable.routes.js";
import { usersRouter } from "./modules/users/users.routes.js";

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

  app.use(helmet());
  app.use(cors());
  app.use(express.json());
  app.use(pinoHttp({ logger }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

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
