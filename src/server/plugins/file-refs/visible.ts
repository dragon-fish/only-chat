import { and, eq, inArray } from 'drizzle-orm'
import type { DB } from '../../db/client'
import { attachments } from '../../db/schema'
import type { Message } from '@/shared/models'
import { assetPrefix } from './ref'

/** What the model was shown of one asset: the prefix it is named by, and the name it was sent under. */
export interface VisibleAsset {
  /** `ASSET_REF_LENGTH` hex digits of the sha256, without the scheme. */
  prefix: string
  filename: string | null
}

/**
 * The assets a generation's model has seen (spec §2.2), keyed by attachment id. This is the only
 * permission boundary `asset:` has: an asset outside it — another branch, conversation or user —
 * resolves as not found, so existence never leaks.
 *
 * Built once from the path at generation start; a file delivered during the turn joins it, since
 * the model has now seen that one too.
 */
export class VisibleAssets {
  private readonly byId = new Map<number, VisibleAsset>()
  /** Attachment id → prefix: what the message builder labels every file with. Live, not a copy. */
  readonly prefixes: ReadonlyMap<number, string> = new Map<number, string>()

  add(attachmentId: number, asset: VisibleAsset): void {
    const known = this.byId.get(attachmentId)
    // The first name an upload was sent under is the one the model saw first; keep it.
    this.byId.set(attachmentId, known && known.filename !== null ? known : asset)
    ;(this.prefixes as Map<number, string>).set(attachmentId, asset.prefix)
  }

  has(attachmentId: number): boolean {
    return this.byId.has(attachmentId)
  }

  get(attachmentId: number): VisibleAsset | undefined {
    return this.byId.get(attachmentId)
  }
}

/**
 * Every attachment the path shows the model, with the filename a part names it by. The sources are
 * exactly spec §2.2's table; anything else on the path — a tool result's JSON, a text part that
 * happens to mention a hash — is not a way to become visible.
 */
export function visibleAttachments(path: readonly Message[]): Map<number, string | null> {
  const found = new Map<number, string | null>()
  const see = (id: number, filename: string | null = null) => {
    if (!found.has(id) || (found.get(id) === null && filename !== null)) found.set(id, filename)
  }
  for (const message of path) {
    for (const part of message.parts) {
      if (message.role === 'user' && (part.type === 'image' || part.type === 'file')) see(part.attachment_id, part.filename ?? null)
      else if (message.role === 'assistant' && part.type === 'image') see(part.attachment_id)
      else if (part.type === 'task_notification') for (const id of part.attachments ?? []) see(id)
      else if (part.type === 'tool_result') for (const id of part.attachments ?? []) see(id)
    }
  }
  return found
}

/** Below D1's 100 bound parameters, with room for the user id. */
const ID_BATCH = 90

/** Adds attachments the model has been shown to `into`, fetching their digests in batches. */
export async function addShownAttachments(db: DB, userId: number, found: ReadonlyMap<number, string | null>, into: VisibleAssets): Promise<VisibleAssets> {
  const ids = [...found.keys()]
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const rows = await db.select({ id: attachments.id, sha256: attachments.sha256 }).from(attachments)
      .where(and(eq(attachments.user_id, userId), inArray(attachments.id, ids.slice(start, start + ID_BATCH))))
    for (const row of rows) into.add(row.id, { prefix: assetPrefix(row.sha256), filename: found.get(row.id) ?? null })
  }
  return into
}

/** Adds what `path` shows to `into`. */
export async function addVisibleAssets(db: DB, userId: number, path: readonly Message[], into: VisibleAssets): Promise<VisibleAssets> {
  return addShownAttachments(db, userId, visibleAttachments(path), into)
}

export async function loadVisibleAssets(db: DB, userId: number, path: readonly Message[]): Promise<VisibleAssets> {
  return addVisibleAssets(db, userId, path, new VisibleAssets())
}
