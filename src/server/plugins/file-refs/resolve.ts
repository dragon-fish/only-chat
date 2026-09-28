import type { Context } from 'cordis'
import { and, eq, gte, lt } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments, type AttachmentRow } from '../../db/schema'
import { assetRef, isAssetRef, parseFileRef, prefixUpperBound, refFailure, ASSET_REF_LENGTH, type FileResult } from './ref'
import type { VisibleAssets } from './visible'

/** Who is resolving, and what they may see. Passed to every `file/resolve` listener. */
export interface FileRefTurn {
  userId: number
  conversationId: number
  projectId: number | null
  /** The tools this generation offers; a provider claims its scheme only when one of its own is on. */
  toolIds: readonly string[]
  visible: VisibleAssets
}

/** A reference translated to the asset behind it (spec §3.2). `ref` is always the `asset:` form. */
export interface ResolvedFile {
  attachmentId: number
  ref: string
  mime: string
  size: number
  width: number | null
  height: number | null
  filename: string | null
}

export function resolvedFromAttachment(row: Pick<AttachmentRow, 'id' | 'sha256' | 'mime' | 'size' | 'width' | 'height'>, filename: string | null): ResolvedFile {
  return { attachmentId: row.id, ref: assetRef(row.sha256), mime: row.mime, size: row.size, width: row.width, height: row.height, filename }
}

/** Candidates can only be a handful of rows; more than this and the answer is "ambiguous" anyway. */
const PREFIX_SCAN_LIMIT = 16

async function assetsByPrefix(db: DB, userId: number, prefix: string): Promise<AttachmentRow[]> {
  const upper = prefixUpperBound(prefix)
  return db.select().from(attachments).where(and(
    eq(attachments.user_id, userId),
    gte(attachments.sha256, prefix),
    ...(upper === null ? [] : [lt(attachments.sha256, upper)]),
  )).limit(PREFIX_SCAN_LIMIT)
}

/** The shortest prefix length, past what was asked, that tells every match apart. */
function distinguishingLength(digests: readonly string[], asked: number): number {
  for (let length = Math.max(asked + 1, ASSET_REF_LENGTH + 1); length < 64; length++) {
    if (new Set(digests.map(digest => digest.slice(0, length))).size === digests.length) return length
  }
  return 64
}

/**
 * Resolves any file reference for a tool. `asset:` is answered here against the turn's visible set;
 * every other scheme goes to the `file/resolve` hook, whose listeners authorize their own scheme.
 */
export async function resolveFileRef(ctx: Context, db: DB, turn: FileRefTurn, ref: string): Promise<FileResult<ResolvedFile>> {
  const parsed = parseFileRef(ref)
  if (!parsed.ok) return parsed
  const value = parsed.value
  if (!isAssetRef(value)) {
    const claimed = await ctx.serial('file/resolve', ref, turn)
    return claimed ?? refFailure('UNSUPPORTED_SCHEME', `Nothing enabled in this turn can open ${value.scheme}: references.`)
  }

  const matches = (await assetsByPrefix(db, turn.userId, value.prefix)).filter(row => turn.visible.has(row.id))
  if (matches.length === 0) {
    return refFailure('FILE_NOT_FOUND', `No file ${ref} in this conversation. Use a reference it showed you, such as the asset: in a file label.`)
  }
  if (matches.length > 1) {
    const length = distinguishingLength(matches.map(row => row.sha256), value.prefix.length)
    const refs = matches.map(row => `asset:${row.sha256.slice(0, length)}`).join(', ')
    return refFailure('AMBIGUOUS_ASSET', `${ref} matches more than one file: ${refs}. Pass the one you mean.`)
  }
  const [row] = matches as [AttachmentRow]
  return { ok: true, value: resolvedFromAttachment(row, turn.visible.get(row.id)?.filename ?? null) }
}
