import { and, eq, inArray } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { attachments } from '@/server/db/schema'
import { assetPrefix } from '@/shared/asset-ref'
import type { AttachmentInfo } from './estimate'

/** Below D1's 100 bound parameters, with room for the user id. */
const ID_BATCH = 90

/** Size, type and `asset:` prefix of the user's attachments among `ids`; another user's are simply absent. */
export async function loadAttachmentInfos(db: DB, userId: number, ids: Iterable<number>): Promise<Map<number, AttachmentInfo>> {
  const unique = [...new Set(ids)]
  const out = new Map<number, AttachmentInfo>()
  for (let start = 0; start < unique.length; start += ID_BATCH) {
    const rows = await db.select({ id: attachments.id, sha256: attachments.sha256, mime: attachments.mime, size: attachments.size })
      .from(attachments)
      .where(and(eq(attachments.user_id, userId), inArray(attachments.id, unique.slice(start, start + ID_BATCH))))
    for (const row of rows) out.set(row.id, { prefix: assetPrefix(row.sha256), mime: row.mime, size: row.size })
  }
  return out
}
