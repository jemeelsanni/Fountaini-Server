import { z } from "zod";

/// Nigerian mobile numbers only, normalised to E.164. Deliberately
/// structural, not a whitelist of operator prefixes: the NCC allocates new
/// ranges over time, and a hardcoded prefix list would make a parent with a
/// newly-issued number unregisterable. A stripped input is accepted iff it
/// is exactly one of:
///   - 11 digits starting "0"     (a local number with its trunk prefix)
///   - 13 digits starting "234"   (country code, no leading +)
///   - "+234" then 10 digits      (already E.164)
/// Anything else — including a bare 10-digit number with neither a leading
/// 0 nor a country code, which has no well-defined national/international
/// reading — is rejected rather than guessed at.
const LOCAL_FORMAT = /^0\d{10}$/;
const COUNTRY_CODE_FORMAT = /^234\d{10}$/;
const E164_FORMAT = /^\+234\d{10}$/;

/// Returns the E.164 form (+234XXXXXXXXXX) of a Nigerian mobile number, or
/// null if the input isn't one of the three accepted shapes above. Strips
/// spaces, dashes, brackets and dots before matching, so any of
/// "0801 234 5678", "0801-234-5678", "(0801) 234 5678" normalise the same
/// as "08012345678".
export function normalizeNigerianPhone(input: string): string | null {
  const stripped = input.replace(/[\s\-().]/g, "");

  if (LOCAL_FORMAT.test(stripped)) {
    return `+234${stripped.slice(1)}`;
  }
  if (COUNTRY_CODE_FORMAT.test(stripped)) {
    return `+${stripped}`;
  }
  if (E164_FORMAT.test(stripped)) {
    return stripped;
  }
  return null;
}

const INVALID_PHONE_MESSAGE =
  "Invalid Nigerian phone number — expected a format like 08012345678, +2348012345678, or 2348012345678";

/// Zod piece for any schema field accepting a Nigerian phone number:
/// validates structurally and normalises to E.164 in the same step, so
/// nothing downstream of parsing can ever see an unnormalised value.
/// Compose with .optional() / .nullable().optional() per field, same as
/// every other optional/nullable string field in this codebase's schemas.
export const phoneSchema = z
  .string()
  .min(1)
  .transform((val, ctx) => {
    const normalized = normalizeNigerianPhone(val);
    if (!normalized) {
      ctx.addIssue({ code: "custom", message: INVALID_PHONE_MESSAGE });
      return z.NEVER;
    }
    return normalized;
  });
