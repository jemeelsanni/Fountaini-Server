import { readFile } from "node:fs/promises";
import { prisma } from "../db/client.js";

/// The real-record categories a go-live reset must never discard silently —
/// see scripts/assertDbEmpty.ts (npm run db:assert-empty / db:reset). A
/// Staff row always has a staffNumber (it's required, not nullable — see
/// the model), so counting Staff rows directly already is "staff with a
/// staff number."
export interface DbRowCounts {
  students: number;
  parents: number;
  payments: number;
  results: number;
  scores: number;
  staff: number;
}

export interface DbEmptyCheckResult {
  /// True only when every one of DbRowCounts is zero — the plain, no-flags
  /// success case, independent of allowDemoOnly.
  empty: boolean;
  counts: DbRowCounts;
  /// True when allowDemoOnly was requested AND every present row traces
  /// back to the demo seed manifest (directly for students/parents/staff,
  /// transitively via studentId for payments/results/scores — see
  /// checkDbEmpty's own comment). Meaningless (always false) when `empty`
  /// is already true or allowDemoOnly wasn't requested.
  allowedByManifest: boolean;
  /// Present only when allowDemoOnly was requested and a manifest was
  /// found: per-category counts of rows NOT listed in it. Null otherwise
  /// (including when manifestMissing is true — there's nothing to count
  /// unaccounted rows against).
  unaccounted: DbRowCounts | null;
  /// True when allowDemoOnly was requested, the database is non-empty, and
  /// prisma/demo-seed-manifest.json could not be read at all — refused
  /// unconditionally, since nothing can be verified against it.
  manifestMissing: boolean;
}

interface DemoSeedManifestIds {
  studentIds: string[];
  parentIds: string[];
  staffIds: string[];
}

export async function loadDemoSeedManifestIds(manifestPath: string): Promise<DemoSeedManifestIds | null> {
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as DemoSeedManifestIds;
  } catch {
    return null;
  }
}

async function countRows(where: {
  studentIds?: string[];
  parentIds?: string[];
  staffIds?: string[];
}): Promise<DbRowCounts> {
  const studentFilter = where.studentIds ? { id: { notIn: where.studentIds } } : undefined;
  const [students, parents, payments, results, scores, staff] = await Promise.all([
    prisma.student.count({ where: studentFilter }),
    prisma.parent.count({ where: where.parentIds ? { id: { notIn: where.parentIds } } : undefined }),
    prisma.payment.count({
      where: where.studentIds ? { feeObligation: { studentId: { notIn: where.studentIds } } } : undefined,
    }),
    prisma.result.count({ where: where.studentIds ? { studentId: { notIn: where.studentIds } } : undefined }),
    prisma.score.count({ where: where.studentIds ? { studentId: { notIn: where.studentIds } } : undefined }),
    prisma.staff.count({ where: where.staffIds ? { id: { notIn: where.staffIds } } : undefined }),
  ]);
  return { students, parents, payments, results, scores, staff };
}

function totalOf(counts: DbRowCounts): number {
  return counts.students + counts.parents + counts.payments + counts.results + counts.scores + counts.staff;
}

/// Payment/Result/Score aren't tracked by id in the demo seed manifest at
/// all (only students/parents/staff are, plus a handful of structural
/// entities unrelated to this check) — adding three more id arrays to keep
/// in sync with every future seed change would be its own maintenance
/// burden. Instead, each is verified TRANSITIVELY via studentId (Payment
/// through its FeeObligation, Result/Score directly): any row whose student
/// isn't itself a manifest-listed demo student is unaccounted for, the same
/// conclusion an explicit id list would have reached, without one.
export async function checkDbEmpty(options: {
  allowDemoOnly: boolean;
  manifestPath: string;
}): Promise<DbEmptyCheckResult> {
  const counts = await countRows({});
  if (totalOf(counts) === 0) {
    return { empty: true, counts, allowedByManifest: false, unaccounted: null, manifestMissing: false };
  }

  if (!options.allowDemoOnly) {
    return { empty: false, counts, allowedByManifest: false, unaccounted: null, manifestMissing: false };
  }

  const manifest = await loadDemoSeedManifestIds(options.manifestPath);
  if (!manifest) {
    return { empty: false, counts, allowedByManifest: false, unaccounted: null, manifestMissing: true };
  }

  const unaccounted = await countRows({
    studentIds: manifest.studentIds,
    parentIds: manifest.parentIds,
    staffIds: manifest.staffIds,
  });

  return {
    empty: false,
    counts,
    allowedByManifest: totalOf(unaccounted) === 0,
    unaccounted,
    manifestMissing: false,
  };
}
