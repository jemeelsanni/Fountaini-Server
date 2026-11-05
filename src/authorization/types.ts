import type { Role } from "../../generated/prisma/index.js";

/// A user can hold more than one role at once (a teacher who's also a
/// parent at the same school, say) — `roles` is the full set they're
/// currently authenticated with, not "the" role. Every authorization check
/// asks "does this principal have role X among their roles", never "is
/// their role X".
export interface Principal {
  userId: string;
  roles: ReadonlySet<Role>;
  staffId: string | null;
  parentId: string | null;
  studentId: string | null;
}

/// Every role in the system, in one place. Used to make "any authenticated
/// role may call this" an explicit declaration (`requireRole(...ALL_ROLES)`)
/// rather than an implicit gap left by bare requireAuth — see the route-guard
/// inventory test, which fails on any route that isn't explicit either way.
export const ALL_ROLES: readonly Role[] = ["ADMIN", "TEACHER", "PARENT", "STUDENT", "BURSAR"];

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- required syntax for augmenting Express's ambient Request type
  namespace Express {
    interface Request {
      principal?: Principal;
      /// validate()'s parsed query result (http/middleware/validate.ts) —
      /// NOT the same object req.query ever returns. Express 5's req.query
      /// is a getter that re-derives a fresh object from req.url on every
      /// access (confirmed directly: it has no own property descriptor on
      /// the request instance at all), so mutating one snapshot of it — the
      /// only thing Express 4 code could safely do, and what this codebase
      /// did until this was found — silently never persists. A controller
      /// reading a Zod-defaulted or coerced query field via req.query was
      /// always getting the raw, un-defaulted, un-coerced value instead;
      /// read req.validatedQuery for any route whose query schema uses
      /// .default(), z.coerce, or .transform() and needs the applied
      /// result, not just presence/shape validation.
      validatedQuery?: unknown;
    }
  }
}
