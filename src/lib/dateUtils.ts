/**
 * Validates an ISO 8601 date string, rejecting non-ISO formats and overflow
 * dates that JavaScript silently normalizes (e.g. "2026-02-31" → "2026-03-03").
 *
 * Accepts:
 * - Date-only: YYYY-MM-DD (parsed as UTC midnight by JS)
 * - Datetime: YYYY-MM-DDTHH:MM[:SS[.mmm]](Z|±HH:MM) — timezone required
 */
export function isValidISODate(str: string): boolean {
  // Enforce ISO 8601 format before attempting to parse (seconds are optional)
  if (
    !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/.test(
      str,
    )
  ) {
    return false;
  }

  const d = new Date(str);
  if (isNaN(d.getTime())) return false;

  // Verify the date components in the prefix are not overflow values that JS
  // silently normalizes (e.g. "2026-02-31" → March 3, "2026-02-31T12:00:00Z"
  // → March 3 at noon). We validate the YYYY-MM-DD portion regardless of
  // whether the string is date-only or datetime: construct a UTC midnight date
  // from the extracted components and check that the result still matches.
  const year = parseInt(str.substring(0, 4), 10);
  const month = parseInt(str.substring(5, 7), 10);
  const day = parseInt(str.substring(8, 10), 10);
  const dateCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    dateCheck.getUTCFullYear() !== year ||
    dateCheck.getUTCMonth() + 1 !== month ||
    dateCheck.getUTCDate() !== day
  ) {
    return false;
  }

  return true;
}
