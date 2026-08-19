import argon2 from "argon2";
import { env } from "../../config/env.js";

/// Test-only, and the lowest parameters argon2id's own C library will
/// accept — libargon2 rejects memoryCost below 8 * parallelism and
/// timeCost/parallelism below 1, so this is the hard floor, not an
/// arbitrary "cheap" choice (verified directly against node_modules/argon2's
/// validate_inputs()). Argon2 hashes are self-describing — the parameters
/// used are encoded in the hash string itself (`$argon2id$v=19$m=8,p=1,t=1$...`)
/// — so a hash produced with these still verifies correctly through the
/// normal argon2.verify() call below; auth tests exercise the real verify
/// path, just against a hash that's fast to produce. Gated once, here — the
/// only function in this codebase that calls argon2.hash — rather than at
/// each caller (see factories.ts and the test files that route through
/// hashPassword() instead of calling argon2 directly).
const TEST_HASH_OPTIONS = { memoryCost: 8, timeCost: 1, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, {
    type: argon2.argon2id,
    ...(env.NODE_ENV === "test" ? TEST_HASH_OPTIONS : {}),
  });
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}
