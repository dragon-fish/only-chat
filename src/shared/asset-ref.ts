/**
 * How an asset is named wherever a model or a person reads it: the first hex digits of its sha256
 * (spec §4.1). The auto-increment attachment id is internal and never appears in such text.
 *
 * Only the format lives here. Resolving a reference back to a file belongs to the `file_reader`
 * plugin, which is the only thing that makes these names mean anything to a model.
 */

export const ASSET_SCHEME = 'asset'

/**
 * How many hex digits of the sha256 an asset is shown by. The resolver accepts anything from here
 * up to the full digest, which is how an ambiguous answer can be followed up.
 */
export const ASSET_REF_LENGTH = 8

export function assetPrefix(sha256: string): string {
  return sha256.slice(0, ASSET_REF_LENGTH)
}

export function assetRef(sha256: string): string {
  return `${ASSET_SCHEME}:${assetPrefix(sha256)}`
}
