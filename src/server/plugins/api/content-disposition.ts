/**
 * `attachment` with the name in both forms RFC 6266 defines. Download managers (FDM and the like)
 * re-request the URL and ignore `<a download>`, so the response itself has to carry the name, and
 * not every one of them reads `filename*` — the quoted ASCII form is their fallback.
 *
 * `encodeURIComponent` alone is not a valid `filename*`: it leaves `'()*` bare, and RFC 8187 does
 * not allow them there.
 */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
