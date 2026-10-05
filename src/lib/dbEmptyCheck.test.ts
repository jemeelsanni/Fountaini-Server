import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBareStudent } from "../test/factories.js";
import { resetDb } from "../test/resetDb.js";
import { checkDbEmpty } from "./dbEmptyCheck.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

// Never actually read when allowDemoOnly is false, or when the DB is
// already empty — a path that plainly doesn't exist stands in for "no
// manifest given" without needing a real missing-file fixture.
const NO_MANIFEST_PATH = "/nonexistent/prisma/demo-seed-manifest.json";

let tmpDirs: string[] = [];
function writeManifest(ids: { studentIds?: string[]; parentIds?: string[]; staffIds?: string[] }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "db-empty-check-"));
  tmpDirs.push(dir);
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({ studentIds: [], parentIds: [], staffIds: [], ...ids }),
  );
  return manifestPath;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("checkDbEmpty", () => {
  it("passes on a freshly reset (empty) database, regardless of allowDemoOnly", async () => {
    const result = await checkDbEmpty({ allowDemoOnly: false, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(true);
    expect(result.counts).toEqual({ students: 0, parents: 0, payments: 0, results: 0, scores: 0, staff: 0 });
  });

  it("fails when rows exist and allowDemoOnly is false", async () => {
    await createBareStudent("ADM-001");

    const result = await checkDbEmpty({ allowDemoOnly: false, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(false);
    expect(result.counts.students).toBe(1);
    expect(result.allowedByManifest).toBe(false);
    expect(result.manifestMissing).toBe(false);
  });

  it("--allow-demo-only refuses unconditionally when the manifest file is missing", async () => {
    await createBareStudent("ADM-001");

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath: NO_MANIFEST_PATH });
    expect(result.empty).toBe(false);
    expect(result.manifestMissing).toBe(true);
    expect(result.allowedByManifest).toBe(false);
  });

  it("--allow-demo-only fails when a row exists that isn't listed in the manifest", async () => {
    const accounted = await createBareStudent("ADM-001");
    await createBareStudent("ADM-002"); // not listed below
    const manifestPath = writeManifest({ studentIds: [accounted.id] });

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });
    expect(result.empty).toBe(false);
    expect(result.manifestMissing).toBe(false);
    expect(result.allowedByManifest).toBe(false);
    expect(result.unaccounted?.students).toBe(1);
  });

  it("--allow-demo-only passes when every row present is listed in the manifest", async () => {
    const a = await createBareStudent("ADM-001");
    const b = await createBareStudent("ADM-002");
    const manifestPath = writeManifest({ studentIds: [a.id, b.id] });

    const result = await checkDbEmpty({ allowDemoOnly: true, manifestPath });
    expect(result.empty).toBe(false);
    expect(result.allowedByManifest).toBe(true);
    expect(result.unaccounted).toEqual({ students: 0, parents: 0, payments: 0, results: 0, scores: 0, staff: 0 });
  });
});
