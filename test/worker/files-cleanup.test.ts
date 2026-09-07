import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { eq, inArray } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/server/app'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, providerInterfaces, providers } from '@/server/db/schema'
import { encryptSecret } from '@/server/plugins/llm/crypto'
import { cleanupExpiredProviderFiles } from '@/server/plugins/files-cleanup'
import { findReusableProviderFile } from '@/server/plugins/hub/sessions'

const now = 1_800_000_000_000
const day = 86_400_000
const db = createDb(env.DB)
const ownedProviders: number[] = []
const ownedAttachments: number[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (ownedProviders.length) await db.delete(providers).where(inArray(providers.id, ownedProviders.splice(0)))
  if (ownedAttachments.length) await db.delete(attachments).where(inArray(attachments.id, ownedAttachments.splice(0)))
})

async function fixture(family: 'openai' | 'anthropic' = 'openai') {
  const ctx = await createApp({ env, side: 'worker' })
  const [provider] = await db.insert(providers).values({
    user_id: 1, name: 'cleanup',
    api_key: await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'cleanup-secret'), created_at: 0,
  }).returning()
  ownedProviders.push(provider!.id)
  const [endpoint] = await db.insert(providerInterfaces).values({
    provider_id: provider!.id, protocol: family === 'openai' ? 'responses' : 'anthropic',
    base_url: 'https://files.test/v1///', native_files: true, created_at: 0,
  }).returning()
  const [attachment] = await db.insert(attachments).values({
    user_id: 1, sha256: crypto.randomUUID(), mime: 'text/plain', size: 3, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0,
  }).returning()
  ownedAttachments.push(attachment!.id)
  await ctx.assets.put(attachment!.r2_key, new TextEncoder().encode('raw'), 'text/plain')
  const pointer = async (reference: Record<string, string> = { [family]: 'file-test' }, patch: Partial<typeof attachmentProviderFiles.$inferInsert> = {}) => {
    const [row] = await db.insert(attachmentProviderFiles).values({
      attachment_id: attachment!.id, provider_id: provider!.id, credential_version: 1,
      file_family: family, base_url: 'https://files.test/v1', provider_reference: reference,
      expires_at: now, cleanup_after: now, created_at: 0, ...patch,
    }).returning()
    return row!
  }
  const rows = () => db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, provider!.id)).orderBy(attachmentProviderFiles.id)
  return { ctx, provider: provider!, endpoint: endpoint!, attachment: attachment!, pointer, rows }
}

function remoteDelete(status: number, family: 'openai' | 'anthropic' = 'openai', deleted = true) {
  const requests: Request[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    const id = decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!)
    return Response.json(status === 200
      ? family === 'openai' ? { id, object: 'file', deleted } : { id, type: 'file_deleted' }
      : { error: { message: 'Authorization: Bearer cleanup-secret; private response', type: 'error' } }, { status })
  })
  return requests
}

describe('remote file cleanup', () => {
  it('reuses and remotely deletes migrated URL aliases with the current Files identity', async () => {
    const legacy = env.TEST_LEGACY_DB
    const cases = [
      { id: 1, family: 'anthropic', original: 'https://api.anthropic.com', scope: 'https://api.anthropic.com/v1' },
      { id: 2, family: 'anthropic', original: 'https://API.ANTHROPIC.COM:443///', scope: 'https://api.anthropic.com/v1' },
      { id: 3, family: 'anthropic', original: 'https://api.anthropic.com/v1', scope: 'https://api.anthropic.com/v1' },
      { id: 4, family: 'anthropic', original: 'https://API.ANTHROPIC.COM/a/../v1///', scope: 'https://api.anthropic.com/v1' },
      { id: 5, family: 'anthropic', original: 'https://ANTHROPIC-GATEWAY.test:443', scope: 'https://anthropic-gateway.test' },
      { id: 6, family: 'anthropic', original: 'https://anthropic-gateway.test/api/./messages///', scope: 'https://anthropic-gateway.test/api/messages' },
      { id: 7, family: 'openai', original: 'https://API.OPENAI.COM/v1', scope: 'https://api.openai.com/v1' },
      { id: 8, family: 'openai', original: 'https://api.openai.com:443/v1', scope: 'https://api.openai.com/v1' },
      { id: 9, family: 'openai', original: 'https://api.openai.com/a/../v1', scope: 'https://api.openai.com/v1' },
      { id: 10, family: 'openai', original: 'https://api.openai.com/v1///', scope: 'https://api.openai.com/v1' },
      { id: 11, family: 'openai', original: 'https://GATEWAY.test:443/openai/./v1///', scope: 'https://gateway.test/openai/v1' },
    ] as const
    await applyD1Migrations(legacy, env.TEST_MIGRATIONS.slice(0, 2))
    await legacy.prepare("INSERT INTO users (id, name, settings, created_at) VALUES (1, 'owner', '{}', 0)").run()
    await legacy.prepare("INSERT INTO attachments (id, user_id, sha256, mime, size, r2_key, origin, created_at) VALUES (1, 1, 'legacy-cleanup', 'text/plain', 1, 'legacy-cleanup', 'upload', 0)").run()
    await legacy.prepare("INSERT INTO attachments (id, user_id, sha256, mime, size, r2_key, origin, created_at) VALUES (2, 1, 'legacy-reuse', 'text/plain', 1, 'legacy-reuse', 'upload', 0)").run()
    const key = await encryptSecret(env.KEY_ENCRYPTION_SECRET, 'migration-cleanup-secret')
    for (const entry of cases) {
      await legacy.prepare("INSERT INTO providers (id, user_id, name, protocol, base_url, api_key, native_files, created_at) VALUES (?, 1, 'Files', ?, ?, ?, 1, 0)")
        .bind(entry.id, entry.family === 'anthropic' ? 'anthropic' : 'openai-responses', entry.original, key).run()
      for (const attachmentId of [1, 2]) {
        await legacy.prepare('INSERT INTO attachment_provider_files (attachment_id, provider_id, provider_reference, expires_at, created_at) VALUES (?, ?, ?, 1000, 0)')
          .bind(attachmentId, entry.id, JSON.stringify({ [entry.family]: `file-${entry.id}-${attachmentId}` })).run()
      }
    }
    await applyD1Migrations(legacy, env.TEST_MIGRATIONS)
    const migratedDb = createDb(legacy)
    const reused = []
    for (const entry of cases) {
      reused.push(await findReusableProviderFile(migratedDb, { providerId: entry.id, credentialVersion: 1, family: entry.family, baseURL: entry.scope }, 2, 500))
    }
    const ctx = await createApp({ env: { ...env, DB: legacy }, side: 'worker' })
    const requests: Request[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(request)
      const id = new URL(request.url).pathname.split('/').at(-1)
      return Response.json(request.headers.has('x-api-key') ? { id, type: 'file_deleted' } : { id, object: 'file', deleted: true })
    })
    const result = await cleanupExpiredProviderFiles(ctx, now)
    expect.soft(reused).toMatchObject(cases.map(entry => ({ base_url: entry.scope, provider_reference: { [entry.family]: `file-${entry.id}-2` } })))
    expect.soft(result).toEqual({ processed: 22, deleted: 22, pruned: 0, retried: 0 })
    expect(requests.map(request => request.url).sort()).toEqual(cases.flatMap(entry => [1, 2].map(attachmentId => `${entry.scope}/files/file-${entry.id}-${attachmentId}`)).sort())
    expect(requests.every(request => request.method === 'DELETE' && (request.headers.get('x-api-key') ?? request.headers.get('authorization'))?.endsWith('migration-cleanup-secret'))).toBe(true)
    expect((await legacy.prepare('SELECT id FROM attachment_provider_files').all()).results).toEqual([])
  })

  it('uses indexed bounded reads for due pointers and provider configuration cleanup', async () => {
    const f = await fixture()
    await env.DB.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 1000)
      INSERT INTO attachment_provider_files (attachment_id, provider_id, credential_version, file_family, base_url, provider_reference, expires_at, cleanup_after, created_at)
      SELECT ?, ?, 1, 'openai', 'https://files.test/v1', '{}', CASE WHEN n <= 10 THEN ? ELSE ? END, CASE WHEN n <= 10 THEN ? ELSE ? END, 0 FROM ids`)
      .bind(f.attachment.id, f.provider.id, now, now + day, now, now + day).run()
    for (const [query, params, index] of [
      ['SELECT * FROM attachment_provider_files WHERE cleanup_after <= ? AND expires_at <= ? ORDER BY cleanup_after, expires_at, id LIMIT 5', [now, now], 'attachment_provider_files_cleanup_idx'],
      ['SELECT * FROM attachment_provider_files WHERE provider_id = ? AND credential_version <= 1 AND id > 0 ORDER BY id LIMIT 5', [f.provider.id], 'attachment_provider_files_provider_idx'],
    ] as const) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...params).all<{ detail: string }>()
      expect(plan.results.some(row => row.detail.includes('SEARCH attachment_provider_files USING INDEX') && row.detail.includes(index))).toBe(true)
      const page = await env.DB.prepare(query).bind(...params).all()
      expect(page.results).toHaveLength(5)
      expect(page.meta.rows_read).toBeLessThanOrEqual(12)
    }
  })

  it('aborts a stalled remote delete and leaves the pointer eligible for a later retry', async () => {
    const f = await fixture()
    await f.pointer()
    let aborted = false
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => { aborted = true; reject(init!.signal!.reason) }, { once: true })
    }))
    await cleanupExpiredProviderFiles(f.ctx, now, { requestTimeoutMs: 5 })
    expect(aborted).toBe(true)
    expect(await f.rows()).toEqual([expect.objectContaining({ cleanup_attempts: 1, cleanup_after: now + day })])
  })

  it('pages due pointers without offsets, caps each run, and bounds remote concurrency', async () => {
    const f = await fixture()
    for (let i = 0; i < 7; i++) await f.pointer({ openai: `file-${i}` })
    let active = 0
    let peak = 0
    const visited: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const id = new URL(new Request(input, init).url).pathname.split('/').at(-1)!
      visited.push(id)
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return Response.json({ id, object: 'file', deleted: true })
    })
    await cleanupExpiredProviderFiles(f.ctx, now, { pageSize: 3, concurrency: 2, maxFiles: 5 })
    expect(peak).toBe(2)
    expect(new Set(visited).size).toBe(5)
    expect(await f.rows()).toHaveLength(2)
    await cleanupExpiredProviderFiles(f.ctx, now, { pageSize: 3, concurrency: 2, maxFiles: 5 })
    expect(new Set(visited).size).toBe(7)
    expect(await f.rows()).toEqual([])
  })

  it.each(['openai', 'anthropic'] as const)('removes confirmed %s deletions and leaves R2 originals intact', async family => {
    const f = await fixture(family)
    await f.pointer()
    const requests = remoteDelete(200, family)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(requests.map(request => [request.method, request.url])).toEqual([['DELETE', 'https://files.test/v1/files/file-test']])
    expect(requests[0]!.headers.get(family === 'openai' ? 'authorization' : 'x-api-key')).toBe(family === 'openai' ? 'Bearer cleanup-secret' : 'cleanup-secret')
    expect(await f.rows()).toEqual([])
    expect(await f.ctx.assets.exists(f.attachment.r2_key)).toBe(true)
  })

  it.each([404, 410])('treats HTTP %s as already deleted', async status => {
    const f = await fixture()
    await f.pointer()
    const requests = remoteDelete(status)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(requests).toHaveLength(1)
    expect(await f.rows()).toEqual([])
  })

  it.each([401, 403, 408, 409, 429, 500, 503, 'network', 'unconfirmed'] as const)('retains and retries %s failures in the next daily window', async failure => {
    const f = await fixture()
    await f.pointer({ openai: 'file-test' }, { base_url: 'https://FILES.test:443/old/../v1///' })
    if (failure === 'network') vi.stubGlobal('fetch', async () => { throw new Error('Authorization: Bearer cleanup-secret') })
    else remoteDelete(failure === 'unconfirmed' ? 200 : failure, 'openai', false)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(await f.rows()).toEqual([expect.objectContaining({ base_url: 'https://files.test/v1', cleanup_attempts: 1, cleanup_after: now + day, expires_at: now })])
    const error = (await f.rows())[0]!.last_cleanup_error!
    expect(error.length).toBeGreaterThan(0)
    expect(error.length).toBeLessThanOrEqual(200)
    expect(error).not.toMatch(/cleanup-secret|Authorization|private response/)
    const requests = remoteDelete(200)
    await cleanupExpiredProviderFiles(f.ctx, now + 1)
    expect(requests).toHaveLength(0)
    await cleanupExpiredProviderFiles(f.ctx, now + day)
    expect(await f.rows()).toEqual([])
  })

  it.each([400, 422])('records and prunes unrecoverable HTTP %s references', async status => {
    const f = await fixture()
    await f.pointer()
    remoteDelete(status)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(await f.rows()).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/cleanup-secret|Authorization|private response/)
  })

  it.each(['openai', 'anthropic'] as const)('prunes an unusable %s namespace without a remote request', async family => {
    const f = await fixture(family)
    await f.pointer({ unrelated: 'opaque' })
    const requests = remoteDelete(200, family)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(await f.rows()).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it.each(['invalid-url', 'https://files.test/v1?key=cleanup-secret', 'https://cleanup-secret@files.test/v1'])('prunes an invalid stored URL without a request or credential disclosure (%s)', async base_url => {
    const f = await fixture()
    await f.pointer({ openai: 'file-test' }, { base_url })
    const requests = remoteDelete(200)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await cleanupExpiredProviderFiles(f.ctx, now)).toEqual({ processed: 1, deleted: 0, pruned: 1, retried: 0 })
    expect(await f.rows()).toEqual([])
    expect(requests).toHaveLength(0)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('cleanup-secret')
  })

  it.each(['missing-interface', 'changed-key', 'missing-key'] as const)('prunes an unreachable scope (%s) without disclosing data', async change => {
    const f = await fixture()
    await f.pointer()
    if (change === 'missing-interface') await db.delete(providerInterfaces).where(eq(providerInterfaces.id, f.endpoint.id))
    else await db.update(providers).set(change === 'changed-key' ? { credential_version: 2 } : { api_key: null }).where(eq(providers.id, f.provider.id))
    const requests = remoteDelete(200)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect(await f.rows()).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it('waits for cleanup_after and never removes a live pointer even when it is due', async () => {
    const f = await fixture()
    await f.pointer({ openai: 'retry-later' }, { cleanup_after: now + day })
    await f.pointer({ openai: 'still-live' }, { expires_at: now + day })
    const requests = remoteDelete(200)
    await cleanupExpiredProviderFiles(f.ctx, now)
    expect((await f.rows()).map(row => row.provider_reference)).toEqual([{ openai: 'retry-later' }, { openai: 'still-live' }])
    expect(requests).toHaveLength(0)
  })
})
