/// Postgres SUM()/COUNT() over integer columns comes back over the wire as
/// int8/numeric, and Prisma's $queryRaw deserializes that inconsistently
/// depending on the exact expression shape: COALESCE(SUM(col), 0) came back
/// as a real JS number in testing, but SUM(colA - colB) (a subtraction
/// inside the aggregate, no COALESCE) came back as a Prisma.Decimal object
/// instead — Postgres infers `numeric` rather than `int8` for that shape,
/// and Prisma maps numeric to Decimal, which then JSON-serializes as a
/// numeric-looking STRING via its own toJSON(), not a number. Confirmed
/// directly, not assumed: a raw-SQL defaulters report's outstandingKobo
/// failed a strict `.toBe(5_000_000)` test with exactly this string-typed
/// mismatch before this existed. Rather than branch on which of
/// number/bigint/string/Decimal a given expression happens to produce,
/// Number() coerces all four correctly on its own — bigint and string
/// convert directly, and Decimal (like decimal.js) exposes a valueOf()
/// returning its string form, which Number()'s object-coercion path then
/// parses the same way. Every raw-SQL aggregate in this codebase should
/// convert through this rather than trust a specific runtime type; kobo
/// amounts and counts are always well within Number's safe integer range
/// for a school this size.
export function toNumber(value: unknown): number {
  return Number(value);
}
