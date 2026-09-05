/** Parses a path segment as a positive integer id. Returns `null` for anything that isn't
 * purely decimal digits (negative, float, hex, empty, non-numeric), so callers can 404
 * instead of letting `Number()` coerce garbage into `NaN` and fall through to a query. */
export function parseId(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null
}
