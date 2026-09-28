import type { ConversationAsset } from '@/shared/conversation-assets'
import type { DB } from '../../db/client'
import { assetPrefix } from './ref'

export type { ConversationAsset }

interface Row {
  attachment_id: number
  sha256: string
  mime: string
  size: number
  width: number | null
  height: number | null
  filename: string | null
  source: 'upload' | 'generated'
  created_at: number
}

/**
 * Every asset of one conversation, across all branches: user uploads, images the chat model
 * produced inline, and the live outputs of image runs started from it. Message parts are matched
 * with `json_each` in SQL, never by scanning JSON text, so an id cannot match as a substring.
 *
 * Ownership is part of every branch: a conversation or run of another user contributes nothing.
 * An attachment reachable from several places is listed once, where it first appeared.
 */
export async function listConversationAssets(db: DB, userId: number, conversationId: number): Promise<ConversationAsset[]> {
  const { results } = await db.$client.prepare(`
    SELECT a.id AS attachment_id, a.sha256, a.mime, a.size, a.width, a.height,
           json_extract(p.value, '$.filename') AS filename,
           CASE m.role WHEN 'user' THEN 'upload' ELSE 'generated' END AS source,
           m.created_at AS created_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id AND c.user_id = ?1
      JOIN json_each(m.parts) p
      JOIN attachments a ON a.id = json_extract(p.value, '$.attachment_id') AND a.user_id = ?1
     WHERE m.conversation_id = ?2
       AND (
         (m.role = 'user' AND json_extract(p.value, '$.type') IN ('image', 'file'))
         OR (m.role = 'assistant' AND json_extract(p.value, '$.type') = 'image'
             AND json_extract(p.value, '$.artifact_id') IS NULL)
       )
    UNION ALL
    SELECT a.id, a.sha256, a.mime, a.size, a.width, a.height, NULL, 'generated', ar.created_at
      FROM artifact_runs r
      JOIN artifacts ar ON ar.run_id = r.id AND ar.user_id = ?1 AND ar.deleted_at IS NULL
      JOIN attachments a ON a.id = ar.attachment_id AND a.user_id = ?1
     WHERE r.conversation_id = ?2 AND r.user_id = ?1
    ORDER BY created_at, attachment_id
  `).bind(userId, conversationId).all<Row>()

  const seen = new Set<number>()
  const out: ConversationAsset[] = []
  for (const row of results) {
    if (seen.has(row.attachment_id)) continue
    seen.add(row.attachment_id)
    out.push({
      attachmentId: row.attachment_id, ref: assetPrefix(row.sha256), source: row.source, mime: row.mime,
      size: row.size, width: row.width, height: row.height, filename: row.filename, createdAt: row.created_at,
    })
  }
  return out
}
