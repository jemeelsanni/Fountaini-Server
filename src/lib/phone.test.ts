import { describe, expect, it } from "vitest";
import { normalizeNigerianPhone, phoneSchema } from "./phone.js";

describe("normalizeNigerianPhone", () => {
  it.each([
    ["08012345678", "+2348012345678"],
    ["0801 234 5678", "+2348012345678"],
    ["234 801 234 5678", "+2348012345678"],
    ["+2348012345678", "+2348012345678"],
    ["2348012345678", "+2348012345678"],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeNigerianPhone(input)).toBe(expected);
  });

  it("rejects a bare 10-digit number with no leading 0 or country code — ambiguous, not guessed at", () => {
    expect(normalizeNigerianPhone("801234 5678")).toBeNull();
  });

  // Proves there's no hardcoded operator-prefix whitelist: 070x/091x are
  // genuinely less common than 080x/081x in casual examples, but this
  // codebase must never reject a structurally valid number just because its
  // prefix looks unfamiliar — the NCC allocates new ranges over time, and a
  // whitelist would make a parent with a newly-issued number unregisterable.
  it.each(["07012345678", "09112345678", "07999999999"])(
    "accepts %s — an unusual but structurally valid prefix, proving no operator whitelist",
    (input) => {
      const result = normalizeNigerianPhone(input);
      expect(result).not.toBeNull();
      expect(result).toMatch(/^\+234\d{10}$/);
    },
  );

  it("strips spaces, dashes, brackets and dots before parsing", () => {
    expect(normalizeNigerianPhone("(0801) 234-56.78")).toBe("+2348012345678");
  });

  it.each([
    ["", null],
    ["12345", null],
    ["080123456789", null], // 12 digits — one too many
    ["0801234567", null], // 10 digits — one too few for the local form
    ["+234801234567", null], // +234 followed by only 9 digits
    ["+23480123456789", null], // +234 followed by 11 digits
    ["abcdefghijk", null],
  ])("rejects %s as unnormalisable", (input, expected) => {
    expect(normalizeNigerianPhone(input)).toBe(expected);
  });
});

describe("phoneSchema", () => {
  it("transforms a valid input to its normalised E.164 form", () => {
    const result = phoneSchema.safeParse("0801 234 5678");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("+2348012345678");
    }
  });

  it("fails with a useful, specific message for an invalid input", () => {
    const result = phoneSchema.safeParse("801234 5678");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/Nigerian phone number/i);
    }
  });
});
