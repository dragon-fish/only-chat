import { env } from 'cloudflare:workers'
import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachments, users } from '@/server/db/schema'
import { Database } from '@/server/plugins/database'
import { Assets } from '@/server/plugins/assets'
import { binaryFromAttachment, FileReader, type FileTurn } from '@/plugins/file-reader/server/service'
import { loadVisibleAssets } from '@/plugins/file-reader/server/visible'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { ensureTestUser } from './auth-helper'

const db = createDb(env.DB)

/** A digest that starts with `prefix` and is otherwise unique, so tests never collide with each other. */
function digest(prefix: string): string {
  return (prefix + crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')).slice(0, 64)
}

async function attachment(userId: number, sha256: string, mime = 'image/png', bytes?: string) {
  const r2Key = `file-reader/${sha256}`
  if (bytes !== undefined) await env.BUCKET.put(r2Key, bytes)
  const [row] = await db.insert(attachments).values({
    user_id: userId, sha256, mime, size: bytes?.length ?? 1, width: 1, height: 1, r2_key: r2Key, origin: 'upload', created_at: 0,
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

/** A root holding only what the reader needs, so what one test registers never reaches another. */
async function reader(): Promise<Context> {
  const ctx = new Context()
  ctx.provide('env', env)
  await ctx.plugin(Database)
  await ctx.plugin(Assets)
  await ctx.plugin(FileReader)
  return ctx
}

async function turnOver(path: Message[], options: { toolIds?: string[], canRead?: (mime: string) => boolean } = {}): Promise<FileTurn> {
  return {
    userId: 1, conversationId: 1, projectId: null, toolIds: options.toolIds ?? [], path, state: new Map(),
    canReadFile: options.canRead ?? (mime => mime.startsWith('image/')),
    visible: await loadVisibleAssets(db, 1, path),
  }
}

describe('file reader: asset references', () => {
  it('resolve an asset the path shows by its short prefix, and only one it shows', async () => {
    await ensureTestUser(db)
    const ctx = await reader()
    const shown = await attachment(1, digest(''))
    const elsewhere = await attachment(1, digest(''))
    const theirs = await attachment(await otherUser(), digest(''))
    // A forged part naming someone else's id does not make their bytes visible either.
    const turn = await turnOver([userMessage([{ type: 'image', attachment_id: shown.id, filename: 'cat.png' }, { type: 'image', attachment_id: theirs.id }])])
    expect(await ctx.fileReader.resolve(turn, `asset:${shown.sha256.slice(0, 8)}`)).toEqual({
      ok: true, value: binaryFromAttachment(shown, 'cat.png'),
    })
    for (const row of [elsewhere, theirs]) {
      expect(await ctx.fileReader.resolve(turn, `asset:${row.sha256.slice(0, 8)}`)).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
    }
  })

  it('report a shared prefix as ambiguous with prefixes that tell the files apart', async () => {
    await ensureTestUser(db)
    const ctx = await reader()
    const common = digest('').slice(0, 8)
    const a = await attachment(1, `${common}0${digest('').slice(9)}`)
    const b = await attachment(1, `${common}1${digest('').slice(9)}`)
    const turn = await turnOver([userMessage([{ type: 'image', attachment_id: a.id }, { type: 'image', attachment_id: b.id }])])
    const result = await ctx.fileReader.resolve(turn, `asset:${common}`)
    expect(result).toMatchObject({ ok: false, error: 'AMBIGUOUS_ASSET' })
    expect(!result.ok && result.message).toContain(`asset:${common}0`)
    expect(await ctx.fileReader.resolve(turn, `asset:${common}1`)).toMatchObject({ ok: true, value: { attachmentId: b.id } })
  })

  it('make task outputs and files delivered this turn referable', async () => {
    await ensureTestUser(db)
    const ctx = await reader()
    const output = await attachment(1, digest(''))
    const delivered = await attachment(1, digest(''))
    const turn = await turnOver([userMessage([
      { type: 'task_notification', task_id: 'image_run:1', plugin_id: 'image_generation', tool_call_id: 'c', status: 'completed', text: '', attachments: [output.id] },
    ])])
    expect(await ctx.fileReader.resolve(turn, `asset:${output.sha256.slice(0, 8)}`)).toMatchObject({ ok: true })
    const ref = `asset:${delivered.sha256.slice(0, 8)}`
    expect(await ctx.fileReader.resolve(turn, ref)).toMatchObject({ ok: false, error: 'FILE_NOT_FOUND' })
    expect(ctx.fileReader.deliver(turn, binaryFromAttachment(delivered, null), 'vfs:/project/a.png')).toMatchObject({
      ok: true, value: { file: ref, mime: 'image/png', __attachments: [delivered.id] },
    })
    expect(await ctx.fileReader.resolve(turn, ref)).toMatchObject({ ok: true, value: { attachmentId: delivered.id } })
  })

  it('read a text asset as numbered lines, a page at a time', async () => {
    await ensureTestUser(db)
    const ctx = await reader()
    const row = await attachment(1, digest(''), 'text/html', '<p>one</p>\n<p>two</p>\n<p>three</p>')
    const turn = await turnOver([userMessage([{ type: 'file', attachment_id: row.id, mime: 'text/html', filename: 'page.html' }])])
    const resolved = await ctx.fileReader.resolve(turn, `asset:${row.sha256.slice(0, 8)}`)
    if (!resolved.ok || resolved.value.kind !== 'text') throw new Error('expected text')
    expect(await resolved.value.read({ offset: 2, limit: 1 })).toEqual({ ok: true, value: {
      file: `asset:${row.sha256.slice(0, 8)}`, content: '2 | <p>two</p>', startLine: 2, returnedLines: 1, totalLines: 3,
      truncated: true, nextOffset: 3, empty: false,
    } })
    expect(await resolved.value.read({ offset: 9 })).toMatchObject({ ok: false, error: 'READ_RANGE_TOO_LARGE' })
  })
})

describe('file reader: other plugins', () => {
  it('hand a scheme and bare paths to whoever registered them, and nothing else', async () => {
    await ensureTestUser(db)
    const ctx = await reader()
    const turn = await turnOver([])
    expect(await ctx.fileReader.resolve(turn, 'vfs:/project/a.png')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' })
    expect(await ctx.fileReader.resolve(turn, '/project/a.png')).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
    const row = await attachment(1, digest(''))
    const seen: string[] = []
    ctx.fileReader.registerScheme('vfs', async (_turn, body) => {
      seen.push(body)
      return { ok: true, value: binaryFromAttachment(row, 'a.png') }
    }, { barePaths: true })
    expect(await ctx.fileReader.resolve(turn, 'vfs:/project/a.png')).toMatchObject({ ok: true, value: { attachmentId: row.id } })
    expect(await ctx.fileReader.resolve(turn, '/project/b.png')).toMatchObject({ ok: true, value: { attachmentId: row.id } })
    expect(seen).toEqual(['/project/a.png', '/project/b.png'])
    expect(await ctx.fileReader.resolve(turn, 's3:bucket/key')).toMatchObject({ ok: false, error: 'UNSUPPORTED_SCHEME' })
  })

  it('finish a cannot-read error with whatever a registered hint says, citing the reference used', async () => {
    const ctx = await reader()
    const pdf = binaryFromAttachment({ id: 7, sha256: 'b41d07a9'.padEnd(64, '0'), mime: 'application/pdf', size: 1, width: null, height: null }, null)
    const turn = await turnOver([])
    expect(ctx.fileReader.deliver(turn, pdf, '/project/report.pdf')).toEqual({
      ok: false, error: 'UNSUPPORTED_FILE', message: 'The current model cannot read application/pdf.',
    })
    ctx.fileReader.registerHint((_turn, mime, cited) => mime === 'application/pdf' ? `Try elsewhere with ${cited}.` : undefined)
    expect(ctx.fileReader.deliver(turn, pdf, '/project/report.pdf')).toMatchObject({
      ok: false, message: 'The current model cannot read application/pdf. Try elsewhere with /project/report.pdf.',
    })
  })
})
