export function parseAuthUserId(value: string | number): number {
  const id = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== String(value)) {
    throw new TypeError('invalid auth user id')
  }
  return id
}
