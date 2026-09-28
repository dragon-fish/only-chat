import { ASSET_SCHEME } from '@/shared/asset-ref'

/**
 * File references (spec §4.3): URIs without an authority. `asset:<hex>` is this plugin's own scheme;
 * any other scheme, and bare absolute paths, belong to whichever plugin registered for them. Nothing
 * here guesses: a malformed reference is an error, never a best-effort match.
 */

export type FileRefError =
  | 'INVALID_FILE_REF' | 'UNSUPPORTED_SCHEME' | 'FILE_NOT_FOUND' | 'AMBIGUOUS_ASSET' | 'UNSUPPORTED_FILE' | 'READ_RANGE_TOO_LARGE'

/** A failure the model can act on, with the sentence that tells it how. */
export interface FileRefFailure {
  ok: false
  error: FileRefError
  message: string
}

export type FileResult<T> = { ok: true, value: T } | FileRefFailure

export function refFailure(error: FileRefError, message: string): FileRefFailure {
  return { ok: false, error, message }
}

/** How a tool reports a failure: the `{ error, message }` shape every tool uses. */
export function fileToolError(failure: FileRefFailure): { error: string, message: string } {
  return { error: failure.error, message: failure.message }
}

export type ParsedFileRef =
  | { kind: 'asset', prefix: string }
  | { kind: 'scheme', scheme: string, body: string }
  | { kind: 'path', path: string }

const ASSET_BODY = /^[0-9a-f]{8,64}$/
const SCHEME = /^([a-z][a-z0-9+.-]*):(.*)$/s

/** Splits a reference. Only `asset:` is validated here; whether a scheme exists is the resolver's question. */
export function parseFileRef(input: string): FileResult<ParsedFileRef> {
  if (input.startsWith('/')) return { ok: true, value: { kind: 'path', path: input } }
  const match = SCHEME.exec(input)
  if (!match) {
    return refFailure('INVALID_FILE_REF', `"${input}" is not a file reference. Use the asset:<hex> a file is labelled with, or a path.`)
  }
  const [, scheme, body] = match as unknown as [string, string, string]
  if (scheme !== ASSET_SCHEME) return { ok: true, value: { kind: 'scheme', scheme, body } }
  if (!ASSET_BODY.test(body)) {
    return refFailure('INVALID_FILE_REF', `"${input}" is not a valid asset reference: asset: takes 8 to 64 lowercase hex digits, for example asset:3f9a2c1e.`)
  }
  return { ok: true, value: { kind: 'asset', prefix: body } }
}

/**
 * The smallest string greater than every string starting with `prefix`, for a range scan on the
 * sha256 index. `null` means no upper bound (the prefix is all `f`). A range and not `LIKE`: SQLite
 * only uses the `(user_id, sha256)` index for a prefix when it is spelled as a range.
 */
export function prefixUpperBound(prefix: string): string | null {
  const trimmed = prefix.replace(/f+$/, '')
  if (trimmed === '') return null
  const last = Number.parseInt(trimmed.at(-1)!, 16)
  return trimmed.slice(0, -1) + (last + 1).toString(16)
}
