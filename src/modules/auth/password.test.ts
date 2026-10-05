import { describe, expect, it } from "vitest";
import { generateTemporaryPassword } from "./password.js";

describe("generateTemporaryPassword", () => {
  it("never produces an ambiguous character (0/O, 1/l/I) across a few thousand generated passwords", () => {
    const AMBIGUOUS_CHARACTERS = ["0", "O", "1", "l", "I"];
    const GENERATION_COUNT = 5000;

    for (let i = 0; i < GENERATION_COUNT; i++) {
      const password = generateTemporaryPassword();
      for (const ambiguous of AMBIGUOUS_CHARACTERS) {
        expect(password, `password #${i} ("${password}") contains ambiguous character "${ambiguous}"`).not.toContain(
          ambiguous,
        );
      }
    }
  });

  it("still produces reasonably high-entropy, non-trivial passwords", () => {
    const password = generateTemporaryPassword();
    expect(password.length).toBeGreaterThanOrEqual(8);
    // Not literally the same character repeated, as a sanity check against
    // a degenerate alphabet.
    expect(new Set(password).size).toBeGreaterThan(1);
  });
});
