import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/client.js";
import { resetDb } from "../../test/resetDb.js";
import {
  generateAdmissionNumber,
  generateStaffNumber,
  registerAdmissionNumberOverride,
} from "./identifiers.service.js";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await resetDb();
});

describe("sequence exhaustion past 999", () => {
  it("fails once a prefix-year's counter would exceed 999, without ever reusing a number", async () => {
    // Pre-seed the counter at 998 rather than actually issuing 998 numbers
    // — this is a unit-level proof of the exhaustion behavior itself, not
    // a race-safety test (see students.test.ts's 4-concurrent-creations
    // test for that, driven through the real endpoint).
    await prisma.identifierCounter.create({ data: { prefix: "FIA/2026", lastValue: 998 } });

    await prisma.$transaction(async (tx) => {
      const n999 = await generateAdmissionNumber(tx, 2026);
      expect(n999).toBe("FIA/2026/999");
    });

    await expect(
      prisma.$transaction(async (tx) => {
        await generateAdmissionNumber(tx, 2026);
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // The failed 1000th attempt's transaction rolled back — the counter
    // is still exactly 999, not bumped past it.
    const counter = await prisma.identifierCounter.findUniqueOrThrow({ where: { prefix: "FIA/2026" } });
    expect(counter.lastValue).toBe(999);
  });

  it("applies the same limit to staff numbers, independently per prefix", async () => {
    await prisma.identifierCounter.create({ data: { prefix: "FIA/ST2026", lastValue: 999 } });

    await expect(
      prisma.$transaction(async (tx) => {
        await generateStaffNumber(tx, 2026);
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("registerAdmissionNumberOverride", () => {
  it("parses the year from the override string itself, not from the year passed to a generate call", async () => {
    // A legacy import from a past year must bump ONLY that year's prefix
    // counter — never today's, and never require knowing today's year at
    // all (see the report on the bug this test pins).
    await prisma.$transaction((tx) => registerAdmissionNumberOverride(tx, "FIA/2019/050"));

    const legacyCounter = await prisma.identifierCounter.findUniqueOrThrow({ where: { prefix: "FIA/2019" } });
    expect(legacyCounter.lastValue).toBe(50);

    const currentCounter = await prisma.identifierCounter.findUnique({ where: { prefix: "FIA/2026" } });
    expect(currentCounter).toBeNull();
  });

  it("never lowers a counter that's already past the override's sequence", async () => {
    await prisma.identifierCounter.create({ data: { prefix: "FIA/2019", lastValue: 100 } });

    await prisma.$transaction((tx) => registerAdmissionNumberOverride(tx, "FIA/2019/050"));

    const counter = await prisma.identifierCounter.findUniqueOrThrow({ where: { prefix: "FIA/2019" } });
    expect(counter.lastValue).toBe(100);
  });
});
