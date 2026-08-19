import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Express, Router } from "express";
import type { RouteMount } from "../authorization/routeInventory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = path.resolve(__dirname, "../modules");

/// Every module directory under src/modules, each holding exactly one
/// *.service.ts / *.controller.ts / *.routes.ts (verified directly, not
/// assumed — see the shell survey this scanner's design is based on).
const MODULE_NAMES = [
  "academic-structure",
  "admissions",
  "attendance",
  "audit",
  "auth",
  "fees",
  "grading",
  "madrassah",
  "notifications",
  "parents",
  "results",
  "school",
  "scores",
  "staff",
  "students",
  "timetable",
  "users",
];

/// Every named `function NAME(` declaration in `text` (exported or not,
/// async or not), in source order, with its byte offset. Arrow-function
/// callbacks (`(tx) => {...}`, `.map((x) => ...)`) never match — which is
/// exactly what makes "nearest preceding boundary" a correct way to find
/// which top-level named function a given offset falls inside, for a
/// codebase (this one) that never nests one named `function` declaration
/// inside another.
function findFunctionBoundaries(text: string): Array<{ name: string; index: number }> {
  const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  const out: Array<{ name: string; index: number }> = [];
  for (const m of text.matchAll(re)) {
    out.push({ name: m[1]!, index: m.index });
  }
  return out;
}

function enclosingFunction(boundaries: Array<{ name: string; index: number }>, offset: number): string | undefined {
  let best: { name: string; index: number } | undefined;
  for (const b of boundaries) {
    if (b.index <= offset && (best === undefined || b.index > best.index)) {
      best = b;
    }
  }
  return best?.name;
}

/// Stage 1: for every module's service file, which exported functions
/// directly contain an AppError.conflict( call. Module name -> function
/// names (there can be more than one call site per function — e.g.
/// scores.service.ts's bulkUpsertScores has two — so this is a Set, not a
/// single answer).
function scanServiceConflictFunctions(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const mod of MODULE_NAMES) {
    const file = path.join(MODULES_DIR, mod, `${mod}.service.ts`);
    const text = readFileSync(file, "utf8");
    const boundaries = findFunctionBoundaries(text);
    const fns = new Set<string>();
    for (const m of text.matchAll(/AppError\.conflict\(/g)) {
      const fn = enclosingFunction(boundaries, m.index);
      if (fn) {
        fns.add(fn);
      }
    }
    if (fns.size > 0) {
      out.set(mod, fns);
    }
  }
  return out;
}

/// Stage 2: for every module's controller file, a map from service
/// function name -> the set of controller function names that call it.
/// Reads the controller's own `import * as ALIAS from "./x.service.js"`
/// line to find the alias actually used (most modules use `service`, but
/// auth/users use `authService`/`usersService` — checked directly rather
/// than assumed).
function scanControllerServiceCalls(): Map<string, Map<string, Set<string>>> {
  const out = new Map<string, Map<string, Set<string>>>();
  for (const mod of MODULE_NAMES) {
    const file = path.join(MODULES_DIR, mod, `${mod}.controller.ts`);
    const text = readFileSync(file, "utf8");
    const importMatch = /import \* as (\w+) from ["']\.\/[\w.-]+\.service\.js["']/.exec(text);
    if (!importMatch) {
      continue;
    }
    const alias = importMatch[1]!;
    const boundaries = findFunctionBoundaries(text);
    const callRe = new RegExp(String.raw`\b${alias}\.(\w+)\(`, "g");
    const map = new Map<string, Set<string>>();
    for (const m of text.matchAll(callRe)) {
      const serviceFn = m[1]!;
      const controllerFn = enclosingFunction(boundaries, m.index);
      if (!controllerFn) {
        continue;
      }
      const set = map.get(serviceFn) ?? new Set<string>();
      set.add(controllerFn);
      map.set(serviceFn, set);
    }
    out.set(mod, map);
  }
  return out;
}

// --- Stage 3: live route -> handler function identity ----------------------
// Deliberately not text-scanning *.routes.ts for this part: path-joining
// (the "/" mount-prefix special case), which controller argument is the
// terminal handler, and matching a route to its actual mounted prefix are
// all things the real Express app already gets right — reimplementing them
// against source text would just be a second, independently-fallible copy
// of routeInventory.ts's own logic. Matching by function *identity* against
// the real running app is exact by construction.

interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
  handle?: unknown;
}

function hasStack(handle: unknown): handle is { stack: ExpressLayer[] } {
  return typeof handle === "function" && "stack" in handle && Array.isArray((handle as { stack: unknown }).stack);
}

function joinPath(prefix: string, routePath: string): string {
  if (routePath === "/") {
    return prefix;
  }
  return `${prefix}${routePath}`;
}

interface LiveRouteHandler {
  method: string;
  path: string;
  handler: unknown;
}

function walkForHandlers(stack: ExpressLayer[], prefix: string, out: LiveRouteHandler[]): void {
  for (const layer of stack) {
    if (!layer.route) {
      continue;
    }
    // The terminal handler is always the last entry in a route's own
    // middleware stack in this codebase — guards/validate/auditMutation are
    // always registered before the controller function, never after (every
    // route registration in every *.routes.ts file follows this order).
    const routeStack = layer.route.stack;
    const terminal = routeStack[routeStack.length - 1]?.handle;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: joinPath(prefix, layer.route.path), handler: terminal });
    }
  }
}

function buildLiveRouteHandlers(app: Express, mounts: RouteMount[]): LiveRouteHandler[] {
  const out: LiveRouteHandler[] = [];
  const prefixByRouter = new Map<Router, string>(mounts.map((m) => [m.router, m.prefix]));
  const expressApp = app as unknown as { router: { stack: ExpressLayer[] } };
  for (const layer of expressApp.router.stack) {
    const prefix = prefixByRouter.get(layer.handle as Router);
    if (prefix !== undefined && hasStack(layer.handle)) {
      walkForHandlers(layer.handle.stack, prefix, out);
    }
  }
  return out;
}

// Statically imported, one per module — not a templated `import(`.../${mod}
// .controller.js`)`) in a loop, even though MODULE_NAMES above already has
// every name: Vite's dynamic-import analysis (which Vitest runs under)
// can't resolve a fully-templated specifier, only ones with a static
// prefix it can enumerate — confirmed by trying the templated form first
// and watching it fail exactly this way under `vitest run` while working
// fine under plain `tsx`. Explicit imports sidestep that bundler-specific
// constraint entirely rather than depending on it.
import * as academicStructureController from "../modules/academic-structure/academic-structure.controller.js";
import * as admissionsController from "../modules/admissions/admissions.controller.js";
import * as attendanceController from "../modules/attendance/attendance.controller.js";
import * as auditController from "../modules/audit/audit.controller.js";
import * as authController from "../modules/auth/auth.controller.js";
import * as feesController from "../modules/fees/fees.controller.js";
import * as gradingController from "../modules/grading/grading.controller.js";
import * as madrassahController from "../modules/madrassah/madrassah.controller.js";
import * as notificationsController from "../modules/notifications/notifications.controller.js";
import * as parentsController from "../modules/parents/parents.controller.js";
import * as resultsController from "../modules/results/results.controller.js";
import * as schoolController from "../modules/school/school.controller.js";
import * as scoresController from "../modules/scores/scores.controller.js";
import * as staffController from "../modules/staff/staff.controller.js";
import * as studentsController from "../modules/students/students.controller.js";
import * as timetableController from "../modules/timetable/timetable.controller.js";
import * as usersController from "../modules/users/users.controller.js";

const CONTROLLER_MODULES: Record<string, Record<string, unknown>> = {
  "academic-structure": academicStructureController,
  admissions: admissionsController,
  attendance: attendanceController,
  audit: auditController,
  auth: authController,
  fees: feesController,
  grading: gradingController,
  madrassah: madrassahController,
  notifications: notificationsController,
  parents: parentsController,
  results: resultsController,
  school: schoolController,
  scores: scoresController,
  staff: staffController,
  students: studentsController,
  timetable: timetableController,
  users: usersController,
};

/// Builds a reverse map from handler function reference -> { module,
/// exportName } over every controller. Function identity is unique
/// regardless of which module exports it (even same-named exports across
/// modules are genuinely distinct function objects), so one flat map
/// across all 16 controllers is safe.
function buildHandlerToControllerExport(): Map<unknown, { module: string; exportName: string }> {
  const out = new Map<unknown, { module: string; exportName: string }>();
  for (const [mod, controllerModule] of Object.entries(CONTROLLER_MODULES)) {
    for (const [exportName, value] of Object.entries(controllerModule)) {
      if (typeof value === "function") {
        out.set(value, { module: mod, exportName });
      }
    }
  }
  return out;
}

/// The full pipeline: every route whose handler ultimately reaches an
/// AppError.conflict( call, resolved from the real, current source files —
/// not a hand-maintained list. A new conflict call site (or a route wired
/// up to reach an existing one) shows up here automatically the next time
/// this runs, with no manual step required to keep it in sync.
export function findConflictRoutes(app: Express, mounts: RouteMount[]): Set<string> {
  const serviceConflictFns = scanServiceConflictFunctions();
  const controllerCalls = scanControllerServiceCalls();
  const liveHandlers = buildLiveRouteHandlers(app, mounts);
  const handlerToExport = buildHandlerToControllerExport();

  // module -> set of controller export names that (transitively, through
  // exactly one hop — service function to controller function) reach a
  // conflict.
  const conflictControllerFns = new Map<string, Set<string>>();
  for (const [mod, serviceFns] of serviceConflictFns) {
    const callMap = controllerCalls.get(mod);
    if (!callMap) {
      continue;
    }
    const fns = new Set<string>();
    for (const serviceFn of serviceFns) {
      for (const controllerFn of callMap.get(serviceFn) ?? []) {
        fns.add(controllerFn);
      }
    }
    if (fns.size > 0) {
      conflictControllerFns.set(mod, fns);
    }
  }

  const routeKeys = new Set<string>();
  for (const route of liveHandlers) {
    const resolved = handlerToExport.get(route.handler);
    if (!resolved) {
      continue;
    }
    const fns = conflictControllerFns.get(resolved.module);
    if (fns?.has(resolved.exportName)) {
      routeKeys.add(`${route.method} ${route.path}`);
    }
  }
  return routeKeys;
}
