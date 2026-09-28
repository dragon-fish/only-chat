/**
 * File references (spec §3.1): URIs without an authority. `asset:<hex>` is the core scheme; any
 * other scheme belongs to whichever plugin claims it through the `file/resolve` hook. Nothing here
 * guesses: a malformed reference is an error, never a best-effort match.
 */

export type FileRefError = 'INVALID_FILE_REF' | 'UNSUPPORTED_SCHEME' | 'FILE_NOT_FOUND' | 'AMBIGUOUS_ASSET' | 'UNSUPPORTED_FILE'

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

export const ASSET_SCHEME = 'asset'
export const VFS_SCHEME = 'vfs'

/**
 * How many hex digits of the sha256 an asset is shown by. The resolver accepts anything from here
 * up to the full digest, which is how an `AMBIGUOUS_ASSET` answer can be followed up.
 */
export const ASSET_REF_LENGTH = 8

const ASSET_BODY = /^[0-9a-f]{8,64}$/
const SCHEME = /^([a-z][a-z0-9+.-]*):(.*)$/s

/** The short form every model-visible text uses. Never the attachment id. */
export function assetPrefix(sha256: string): string {
  return sha256.slice(0, ASSET_REF_LENGTH)
}

export function assetRef(sha256: string): string {
  return `${ASSET_SCHEME}:${assetPrefix(sha256)}`
}

export function vfsRef(path: string): string {
  return `${VFS_SCHEME}:${path}`
}

export type ParsedFileRef =
  | { scheme: typeof ASSET_SCHEME, prefix: string }
  | { scheme: string, body: string }

export function isAssetRef(ref: ParsedFileRef): ref is { scheme: typeof ASSET_SCHEME, prefix: string } {
  return ref.scheme === ASSET_SCHEME
}

/**
 * Splits a reference into scheme and body. Only `asset:` is validated here; whether any other
 * scheme exists is for the resolver to find out, since a plugin may claim it.
 */
export function parseFileRef(input: string): FileResult<ParsedFileRef> {
  if (input.startsWith('/')) {
    return refFailure('INVALID_FILE_REF', `"${input}" is a bare path, not a file reference. When workspace file tools are on, a workspace file is referenced as ${vfsRef(input)}.`)
  }
  const match = SCHEME.exec(input)
  if (!match) {
    return refFailure('INVALID_FILE_REF', `"${input}" is not a file reference. Use asset:<hex> for a file shown in this conversation.`)
  }
  const [, scheme, body] = match as unknown as [string, string, string]
  if (scheme !== ASSET_SCHEME) return { ok: true, value: { scheme, body } }
  if (!ASSET_BODY.test(body)) {
    return refFailure('INVALID_FILE_REF', `"${input}" is not a valid asset reference: asset: takes 8 to 64 lowercase hex digits, for example asset:3f9a2c1e.`)
  }
  return { ok: true, value: { scheme: ASSET_SCHEME, prefix: body } }
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
