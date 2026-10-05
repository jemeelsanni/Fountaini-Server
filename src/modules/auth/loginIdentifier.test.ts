import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeLoginIdentifier } from "./loginIdentifier.js";

describe("normalizeLoginIdentifier", () => {
  it("trims and lowercases an email-shaped identifier, including a capitalized one", () => {
    expect(normalizeLoginIdentifier("Parent@Test.Local")).toBe("parent@test.local");
    expect(normalizeLoginIdentifier("  parent@test.local  ")).toBe("parent@test.local");
    expect(normalizeLoginIdentifier(" Parent@Test.Local ")).toBe("parent@test.local");
  });

  it("trims and uppercases an ID-shaped identifier, including a lowercase one", () => {
    expect(normalizeLoginIdentifier("fia/2026/001")).toBe("FIA/2026/001");
    expect(normalizeLoginIdentifier("  FIA/2026/001  ")).toBe("FIA/2026/001");
    expect(normalizeLoginIdentifier("fia/st2026/001")).toBe("FIA/ST2026/001");
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Someone@Example.COM  ")).toBe("someone@example.com");
  });
});
