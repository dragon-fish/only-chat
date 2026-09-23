/** Square tiles sized for the chat column, which is narrower than Studio's. */
export function thumbnailGridClass(count: number): string {
  if (count <= 1) return 'max-w-xs grid-cols-1'
  if (count === 2) return 'max-w-md grid-cols-2'
  if (count === 3) return 'max-w-lg grid-cols-3'
  if (count === 4) return 'max-w-sm grid-cols-2'
  return 'max-w-2xl grid-cols-3 sm:grid-cols-5'
}
