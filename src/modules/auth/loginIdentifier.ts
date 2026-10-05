/// Shared by every place a login identifier or an account's email is read
/// or written — login()/requestPasswordReset() (both via
/// findUserByIdentifier, auth.service.ts), and every creation/update path
/// that stores one (createParent, createStaff, createUser, updateUserEmail).
/// Without this, a phone keyboard's auto-capitalized first letter, a pasted
/// trailing space, or a lowercase admission number typed by hand all fail
/// to match a canonically-stored value — not a wrong password, just a
/// string that doesn't look like the one actually stored.
///
/// Email-shaped (contains "@") -> trimmed and lowercased. ID-shaped (an
/// admission/staff number, e.g. "FIA/2026/001") -> trimmed and uppercased —
/// these are already stored canonically-uppercase by construction
/// (ADMISSION_NUMBER_FORMAT/STAFF_NUMBER_FORMAT are case-sensitive regexes
/// requiring literal uppercase "FIA", enforced wherever one is actually
/// created — see identifiers.service.ts), so this only matters for what
/// the CALLER typed, not what's stored.
export function normalizeLoginIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

/// Canonicalizes an email for storage (User.email, and loginId wherever it
/// mirrors email — parent and bare accounts; see User.loginId's own schema
/// comment) — trim + lowercase, so two accounts can never collide on case
/// alone and a stored value always matches what normalizeLoginIdentifier
/// produces from the same address at login time.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
