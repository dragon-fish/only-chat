/** A malformed URL still has to render as something; the raw string is the honest fallback. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The calendar day a result was published, in the reader's own locale; a bad date shows as given. */
export function dateOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString()
}
