import { createHash, randomBytes } from "node:crypto";

/// Refresh tokens are high-entropy random values, not user-chosen secrets —
/// SHA-256 is the correct hash here (deterministic, so we can look rows up by
/// hash equality), unlike argon2 which is deliberately slow and salted for
/// low-entropy password guessing resistance. Never store the raw token.
export function generateRefreshToken(): string {
  return randomBytes(64).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
