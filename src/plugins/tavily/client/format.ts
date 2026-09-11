/** A malformed URL still has to render as something; the raw string is the honest fallback. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
