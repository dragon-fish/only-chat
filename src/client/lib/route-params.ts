/** Route params are strings (or arrays for repeatable segments); ids are numbers. */
export function routeParamToId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}
