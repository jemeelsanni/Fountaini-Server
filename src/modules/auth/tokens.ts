import { createHash, randomBytes } from "node:crypto";

/// Shared by every opaque, high-entropy bearer token this codebase issues
/// and only ever looks up by hash — refresh tokens, and password reset
/// tokens (see auth.service.ts's requestPasswordReset/resetPassword).
/// SHA-256 is the correct hash here (deterministic, so we can look rows up
/// by hash equality), unlike argon2 which is deliberately slow and salted
/// for low-entropy password guessing resistance — these tokens are neither
/// low-entropy nor user-chosen. Never store the raw token.
export function generateOpaqueToken(): string {
  return randomBytes(64).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
