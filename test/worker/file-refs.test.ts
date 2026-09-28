import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachments, users } from '@/server/db/schema'
import { resolveFileRef, type FileRefTurn } from '@/server/plugins/file-refs/resolve'
import { deliverFile } from '@/server/plugins/file-refs/deliver'
import { loadVisibleAssets } from '@/server/plugins/file-refs/visible'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'

const db = createDb(env.DB)

/** A digest that starts with `prefix` and is otherwise unique, so tests never collide with each other. */
function digest(prefix: string): string {
  return (prefix + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')).slice(0, 64)
}

async function attachment(userId: number, sha256: string, mime = 'image/png') {
  const [row] = await db.insert(attachments).values({
    user_id: userId, sha256, mime, size: 1, width: 1, height: 1, r2_key: `file-refs/${sha256}`, origin: 'upload', created_at: 0,
  }).returning()
  return row!
}

async function otherUser(): Promise<number> {
  const [row] = await db.insert(users).values({
    name: 'other', email: `${crypto.randomUUID()}@example.com`, settings: { plugins: {} }, createdAt: new Date(0), updatedAt: new Date(0),
  }).returning()
  return row!.id
}

function userMessage(parts: Part[]): Message {
  return { id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'user', parts, provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0 }
}

async function turnOver(path: Message[], toolIds: string[] = []): Promise<FileRefTurn> {
  return { userId: 1, conversationId: 1, projectId: null, toolIds, visible: await loadVisibleAssets(db, 1, path) }
}

const reader = { canRead: (mime: string) => mime.startsWith('image/') }

describe('resolveFileRef', () => {
  it('resolves an asset the path shows, by its short prefix', async () => {
    await ensureTestUser(db)
    const sha = digest('')
    const row = await attachment(1, sha)
    const turn = await turnOver([userMessage([{ type: 'image', attachment_id: row.id, filename: 'cat.png' }])])
    expect(await resolveFileRef(new Context(), db, turn, `asset:${sha.slice(0, 8)}`)).toEqual({ ok: true, value: {
      attachmentId: row.id, sha256: sha, ref: `asset:${sha.slice(0, 8)}`, mime: 'image/png', size: 1, width: 1, height: 1, filename: 'cat.png',
    } })
  })

  it('treats anything the path does not show as not found, whoever owns it', async () => {
    await ensureTestUser(db)
    const shown = await attachment(1, digest(''))
    const elsewhere = await attachment(1, digest(''))
    const theirs = await attachment(await otherUser(), digest(''))
    // A forged part naming someone else's id does not make their bytes visible either.
    const turn = await turnOver([userMessage([{ type: 'image', attachment_id: shown.id }, { type: 'image', attachment_id: theirs.id }])])
    for (const row of [elsewhere, theirs]) {
      expect(await resolveFileRef(new Context(), db, turn, `asset:${row.sha256.slice(0, 8)}`)).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
    }
  })

  it('reports a shared prefix as ambiguous with prefixes that tell the files apart', async () => {
    await ensureTestUser(db)
    const common = digest('').slice(0, 8)
    const a = await attachment(1, `${common}0${digest('').slice(9)}`)
    const b = await attachment(1, `${common}1${digest('').slice(9)}`)
    const turn = await turnOver([userMessage([{ type: 'image', attachment_id: a.id }, { type: 'image', attachment_id: b.id }])])
    const result = await resolveFileRef(new Context(), db, turn, `asset:${common}`)
    expect(result).toMatchObject({ ok: false, error: 'AMBIGUOUS_ASSET' })
    expect(!result.ok && result.message).toContain(`asset:${common}0`)
    expect(await resolveFileRef(new Context(), db, turn, `asset:${common}1`)).toMatchObject({ ok: true, value: { attachmentId: b.id } })
  })

  it('makes task outputs and files delivered this turn referable', async () => {
    await ensureTestUser(db)
    const output = await attachment(1, digest(''))
    const delivered = await attachment(1, digest(''))
    const turn = await turnOver([userMessage([
      { type: 'task_notification', task_id: 'image_run:1', plugin_id: 'image_generation', tool_call_id: 'c', status: 'completed', text: '', attachments: [output.id] },
    ])])
    expect(await resolveFileRef(new Context(), db, turn, `asset:${output.sha256.slice(0, 8)}`)).toMatchObject({ ok: true })
    const ref = `asset:${delivered.sha256.slice(0, 8)}`
    expect(await resolveFileRef(new Context(), db, turn, ref)).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
    deliverFile(turn, reader, { attachmentId: delivered.id, sha256: delivered.sha256, ref, mime: 'image/png', size: 1, width: 1, height: 1, filename: null }, 'vfs:/project/a.png')
    expect(await resolveFileRef(new Context(), db, turn, ref)).toMatchObject({ ok: true, value: { attachmentId: delivered.id } })
  })

  it('hands other schemes to the hook, and nobody claiming one is an unsupported scheme', async () => {
    await ensureTestUser(db)
    const turn = await turnOver([])
    const ctx = new Context()
    expect(await resolveFileRef(ctx, db, turn, 'vfs:/project/a.png')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' })
    const row = await attachment(1, digest(''))
    ctx.on('file/resolve', async ref => ref.startsWith('vfs:')
      ? { ok: true, value: { attachmentId: row.id, sha256: row.sha256, ref: `asset:${row.sha256.slice(0, 8)}`, mime: 'image/png', size: 1, width: 1, height: 1, filename: 'a.png' } }
      : undefined)
    expect(await resolveFileRef(ctx, db, turn, 'vfs:/project/a.png')).toMatchObject({ ok: true, value: { attachmentId: row.id } })
    expect(await resolveFileRef(ctx, db, turn, 's3:bucket/key')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' })
    expect(await resolveFileRef(ctx, db, turn, '/project/a.png')).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
  })
})

describe('deliverFile', () => {
  const understanding = { canRead: (mime: string) => mime === 'application/pdf', analyze: async () => { throw new Error('unused') } }
  const pdf = { attachmentId: 7, sha256: 'b41d07a9'.padEnd(64, '0'), ref: 'asset:b41d07a9', mime: 'application/pdf', size: 1, width: null, height: null, filename: null }

  it('returns a receipt naming the asset and hands the id over under the reserved key', async () => {
    const turn = await turnOver([])
    expect(deliverFile(turn, { canRead: () => true }, pdf, 'asset:b41d07a9')).toEqual({ ok: true, value: {
      file: 'asset:b41d07a9', mime: 'application/pdf', message: expect.any(String), __attachments: [7],
    } })
  })

  it('suggests analyze_file only when the tool is on and its model can read the file', async () => {
    const cited = 'vfs:/project/report.pdf'
    const message = async (toolIds: string[], withService: boolean) => {
      const result = deliverFile(await turnOver([], toolIds), { canRead: () => false, ...(withService ? { understanding } : {}) }, pdf, cited)
      expect(result).toMatchObject({ ok: false, error: 'UNSUPPORTED_FILE' })
      return result.ok ? '' : result.message
    }
    expect(await message(['analyze_file'], true)).toContain(`analyze_file with file ${cited}`)
    expect(await message([], true)).not.toContain('analyze_file')
    expect(await message(['analyze_file'], false)).not.toContain('analyze_file')
  })
})
