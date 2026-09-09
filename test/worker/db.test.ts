import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, messages, projects, providerInterfaces, providers, conversations, users } from '@/server/db/schema'
import { findReusableProviderFile, insertProviderFile } from '@/server/plugins/hub/conversations'

describe('D1 schema', () => {
  it('inserts a conversation and a message tree', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [s] = await db.insert(conversations).values({
      user_id: 1, title: 't', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const [u] = await db.insert(messages).values({
      conversation_id: s!.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2,
    }).returning()
    const [a] = await db.insert(messages).values({
      conversation_id: s!.id, parent_id: u!.id, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: 'm', usage: { prompt: 1, completion: 0 }, status: 'error', error: null, created_at: 3,
    }).returning()
    const rows = await db.select().from(messages).where(eq(messages.conversation_id, s!.id)).orderBy(messages.seq)
    expect(rows.map((r) => r.id)).toEqual([u!.id, a!.id])
    expect(rows[1]!.usage).toEqual({ prompt: 1, completion: 0 })
    expect(rows[0]!.parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('enforces unique (conversation_id, seq)', async () => {
    const db = createDb(env.DB)
    const [s] = await db.insert(conversations).values({
      user_id: 1, title: 't2', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const row = {
      conversation_id: s!.id, parent_id: null, seq: 1, role: 'user' as const, parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0,
    }
    await db.insert(messages).values(row)
    await expect(db.insert(messages).values(row)).rejects.toThrow()
  })

  it('creates a project with only name required, and defaults interface native_files to false', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(projects).values({
      user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null,
      params: null, created_at: 1, updated_at: 1,
    }).returning()
    expect(p!.name).toBe('Design')

    const [provider] = await db.insert(providers).values({
      user_id: 1, name: 'p1', created_at: 0,
    }).returning()
    const [endpoint] = await db.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://api.example.com', created_at: 0 }).returning()
    expect(endpoint!.native_files).toBe(false)
  })

  it('sets conversation.project_id to null when its Project is deleted', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(projects).values({
      user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null,
      params: null, created_at: 1, updated_at: 1,
    }).returning()
    const [s] = await db.insert(conversations).values({
      user_id: 1, title: 't3', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, project_id: p!.id, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    expect(s!.project_id).toBe(p!.id)

    await db.delete(projects).where(eq(projects.id, p!.id))
    const [reloaded] = await db.select().from(conversations).where(eq(conversations.id, s!.id))
    expect(reloaded!.project_id).toBeNull()
  })

  it('preserves multiple historical attachment provider file pointers', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [a] = await db.insert(attachments).values({
      user_id: 1, sha256: 'a'.repeat(64), mime: 'image/png', size: 10, width: null, height: null,
      r2_key: 'k1', origin: 'upload', created_at: 0,
    }).returning()
    const [p1] = await db.insert(providers).values({
      user_id: 1, name: 'p1', created_at: 0,
    }).returning()
    const [p2] = await db.insert(providers).values({
      user_id: 1, name: 'p2', created_at: 0,
    }).returning()

    const scope = { providerId: p1!.id, credentialVersion: 1, family: 'openai' as const, baseURL: 'https://api.example.com' }
    const pointer = { attachment_id: a!.id, provider_id: p1!.id, credential_version: 1, file_family: 'openai' as const, base_url: scope.baseURL, cleanup_after: 2000 }
    await insertProviderFile(db, {
      ...pointer,
      attachment_id: a!.id, provider_id: p1!.id, provider_reference: { openai: 'file-1' },
      expires_at: 1000, created_at: 0,
    })
    await insertProviderFile(db, {
      ...pointer, file_family: 'anthropic',
      attachment_id: a!.id, provider_id: p2!.id, provider_reference: { anthropic: 'file-2' },
      expires_at: 1000, created_at: 0,
    })
    const rows = await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))
    expect(rows).toHaveLength(2)

    await insertProviderFile(db, {
      ...pointer,
      attachment_id: a!.id, provider_id: p1!.id, provider_reference: { openai: 'file-3' },
      expires_at: 2000, created_at: 0,
    })
    expect(await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))).toHaveLength(3)
    expect((await findReusableProviderFile(db, scope, a!.id, 500))!.provider_reference).toEqual({ openai: 'file-3' })
    expect((await findReusableProviderFile(db, { ...scope, providerId: p2!.id, family: 'anthropic' }, a!.id, 500))!.provider_reference).toEqual({ anthropic: 'file-2' })
    for (const changedScope of [
      { ...scope, providerId: p2!.id },
      { ...scope, credentialVersion: 2 },
      { ...scope, family: 'anthropic' as const },
      { ...scope, baseURL: 'https://other.example.com' },
    ]) expect(await findReusableProviderFile(db, changedScope, a!.id, 500)).toBeUndefined()
    // A newer expired upload must not hide an older valid reference, including equal timestamps.
    await insertProviderFile(db, { ...pointer, provider_reference: { openai: 'expired' }, expires_at: 500, created_at: 1 })
    expect((await findReusableProviderFile(db, scope, a!.id, 500))!.provider_reference).toEqual({ openai: 'file-3' })
    expect(await findReusableProviderFile(db, scope, a!.id, 2000)).toBeUndefined()
    expect(await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))).toHaveLength(4)
  })

  it.each([
    { family: 'openai' as const, original: 'https://FILES.test:443/api/../v1///', canonical: 'https://files.test/v1' },
    { family: 'anthropic' as const, original: 'https://API.ANTHROPIC.COM:443/path/..///', canonical: 'https://api.anthropic.com/v1' },
    { family: 'anthropic' as const, original: 'https://GATEWAY.test:443/api/./messages///', canonical: 'https://gateway.test/api/messages' },
  ])('normalizes uploads and selects the newest valid pointer across URL spellings ($family, $original)', async ({ family, original, canonical }) => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [attachment] = await db.insert(attachments).values({ user_id: 1, sha256: crypto.randomUUID(), mime: 'text/plain', size: 1, r2_key: crypto.randomUUID(), origin: 'upload', created_at: 0 }).returning()
    const [provider] = await db.insert(providers).values({ user_id: 1, name: 'canonical-files', created_at: 0 }).returning()
    const pointer = { attachment_id: attachment!.id, provider_id: provider!.id, credential_version: 1, file_family: family, base_url: original, expires_at: 1000, cleanup_after: 1000, created_at: 0 }
    await insertProviderFile(db, { ...pointer, provider_reference: { [family]: 'uploaded' } })
    const [uploaded] = await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.provider_id, provider!.id))
    expect.soft(uploaded!.base_url).toBe(canonical)
    await db.insert(attachmentProviderFiles).values([
      { ...pointer, base_url: canonical, provider_reference: { [family]: 'older-canonical' }, created_at: 1 },
      { ...pointer, provider_reference: { [family]: 'latest-legacy' }, created_at: 2 },
      { ...pointer, provider_reference: { [family]: 'expired' }, created_at: 3, expires_at: 500 },
      { ...pointer, base_url: 'https://unrelated.test/v1', provider_reference: { [family]: 'other-scope' }, created_at: 4 },
      { ...pointer, base_url: 'invalid-url', provider_reference: { [family]: 'invalid' }, created_at: 5 },
    ])
    await env.DB.prepare(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 55)
      INSERT INTO attachment_provider_files (attachment_id, provider_id, credential_version, file_family, base_url, provider_reference, expires_at, cleanup_after, created_at)
      SELECT ?, ?, 1, ?, 'https://unrelated.test/scope-' || n, '{}', 1000, 1000, n + 10 FROM ids`)
      .bind(attachment!.id, provider!.id, family).run()
    const scope = { providerId: provider!.id, credentialVersion: 1, family, baseURL: canonical }
    const reused = await findReusableProviderFile(db, scope, attachment!.id, 500)
    expect(reused).toMatchObject({ base_url: canonical, provider_reference: { [family]: 'latest-legacy' } })
    expect((await db.query.attachmentProviderFiles.findFirst({ where: eq(attachmentProviderFiles.id, reused!.id) }))!.base_url).toBe(canonical)
    expect(await findReusableProviderFile(db, { ...scope, baseURL: original }, attachment!.id, 500)).toMatchObject({ provider_reference: { [family]: 'latest-legacy' } })
    expect(await findReusableProviderFile(db, scope, attachment!.id, 1000)).toBeUndefined()
  })

  it('stores two interfaces and rejects duplicate protocols and dangling interface references', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(providers).values({ user_id: 1, name: 'interfaces', created_at: 0 }).returning()
    const insert = (protocol: string) => env.DB.prepare('INSERT INTO provider_interfaces (provider_id, protocol, base_url, created_at) VALUES (?, ?, ?, 0)').bind(p!.id, protocol, 'https://example.com/v1').run()
    const response = await insert('responses')
    await insert('chat-completions')
    await expect(insert('responses')).rejects.toThrow()
    await expect(insert('vertex')).rejects.toThrow()
    await expect(env.DB.prepare("INSERT INTO provider_interfaces (provider_id, protocol, base_url, native_files, created_at) VALUES (?, 'vertex-compatible', 'https://example.com', 1, 0)").bind(p!.id).run()).rejects.toThrow()
    await env.DB.prepare('UPDATE providers SET default_interface_id = ? WHERE id = ?').bind(response.meta.last_row_id, p!.id).run()
    await expect(env.DB.prepare('UPDATE providers SET default_interface_id = -1 WHERE id = ?').bind(p!.id).run()).rejects.toThrow()
    await expect(env.DB.prepare("INSERT INTO models (provider_id, model_id, interface_id) VALUES (?, 'dangling', -1)").bind(p!.id).run()).rejects.toThrow()
    await env.DB.prepare("INSERT INTO models (provider_id, model_id, interface_id) VALUES (?, 'valid', ?)").bind(p!.id, response.meta.last_row_id).run()
    await expect(env.DB.prepare('DELETE FROM provider_interfaces WHERE id = ?').bind(response.meta.last_row_id).run()).rejects.toThrow()
    await db.delete(providers).where(eq(providers.id, p!.id))
    expect(await env.DB.prepare('SELECT count(*) AS n FROM provider_interfaces WHERE provider_id = ?').bind(p!.id).first('n')).toBe(0)
  })

  it('installs indexed filter paths and an FTS5 substring search kept current on writes', async () => {
    const names = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'models'").all<{ name: string }>()
    expect(names.results.map(row => row.name)).toEqual(expect.arrayContaining([
      'models_provider_enabled_sort_idx', 'models_enabled_image_idx', 'models_enabled_reasoning_idx', 'models_enabled_context_idx',
    ]))
    for (const [query, index] of [
      ['SELECT id FROM models WHERE provider_id = 1 AND enabled = 1 ORDER BY sort, id LIMIT 50', 'models_provider_enabled_sort_idx'],
      ['SELECT id FROM models WHERE enabled = 1 AND supports_image_input = 1 ORDER BY sort, id LIMIT 50', 'models_enabled_image_idx'],
      ['SELECT id FROM models WHERE enabled = 1 AND supports_reasoning = 1 ORDER BY sort, id LIMIT 50', 'models_enabled_reasoning_idx'],
      ['SELECT id FROM models WHERE enabled = 1 AND context_limit >= 1000 LIMIT 50', 'models_enabled_context_idx'],
    ]) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${query}`).all<{ detail: string }>()
      expect(plan.results.some(row => row.detail.includes('SEARCH models USING') && row.detail.includes(index!))).toBe(true)
    }
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(providers).values({ user_id: 1, name: 'fts', created_at: 0 }).returning()
    const inserted = await env.DB.prepare("INSERT INTO models (provider_id, model_id, search_name, metadata_resolved, metadata_override) VALUES (?, 'search-model', 'claude opus', ?, ?)")
      .bind(p!.id, JSON.stringify({ reasoning: false, cost: { input: 0 } }), JSON.stringify({ cost: null })).run()
    const modelId = inserted.meta.last_row_id
    expect(await env.DB.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'laud'").first('rowid')).toBe(modelId)
    const metadata = await env.DB.prepare('SELECT metadata_resolved, metadata_override FROM models WHERE id = ?').bind(modelId).first<{ metadata_resolved: string; metadata_override: string }>()
    expect(JSON.parse(metadata!.metadata_resolved)).toEqual({ reasoning: false, cost: { input: 0 } })
    expect(JSON.parse(metadata!.metadata_override)).toEqual({ cost: null })
    await env.DB.prepare("UPDATE models SET search_name = 'gemini flash' WHERE id = ?").bind(modelId).run()
    expect(await env.DB.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'laud'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'emin'").first('rowid')).toBe(modelId)
    await db.delete(providers).where(eq(providers.id, p!.id))
    expect(await env.DB.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'emin'").first()).toBeNull()
  })

  it('migrates legacy data without losing credentials, false/zero metadata or native Vertex records', async () => {
    const legacy = env.TEST_LEGACY_DB
    await applyD1Migrations(legacy, env.TEST_MIGRATIONS.slice(0, 2))
    await legacy.prepare("INSERT OR IGNORE INTO users (id, name, settings, created_at) VALUES (1, 'owner', '{}', 0)").run()
    await legacy.prepare("INSERT INTO providers (id, user_id, name, protocol, base_url, api_key, native_files, created_at) VALUES (1, 1, 'OpenAI', 'openai-responses', 'https://api.openai.com/v1/', 'encrypted-value', 1, 0), (2, 1, 'Native Vertex', 'vertex', 'https://aiplatform.googleapis.com', 'vertex-key', 0, 0), (3, 1, 'Custom', 'vertex-compatible', 'https://gateway.example.com/v1', NULL, 1, 0), (4, 1, 'Custom', 'anthropic', 'https://api.anthropic.com/v1', NULL, 0, 0), (5, 1, 'Custom', 'openai-completions', 'https://unknown.example.com/v1', NULL, 0, 0)").run()
    await legacy.prepare("INSERT INTO models (id, provider_id, model_id, display_name, capabilities, pricing) VALUES (1, 1, 'model', 'Custom Name', ?, ?), (2, 2, 'vertex-model', 'vertex-model', '{}', NULL)")
      .bind(JSON.stringify({ vision: false, reasoning: false, tools: true, image_output: true, reasoning_can_disable: true, reasoning_efforts: ['low', 'high', 'ultra'] }), JSON.stringify({ input: 0, output: 2, cached: 0 })).run()
    await legacy.prepare("INSERT INTO attachments (id, user_id, sha256, mime, size, r2_key, origin, created_at) VALUES (1, 1, 'legacy', 'image/png', 1, 'legacy', 'upload', 0)").run()
    await legacy.prepare("INSERT INTO attachment_provider_files (attachment_id, provider_id, provider_reference, expires_at, created_at) VALUES (1, 1, '{}', 1000, 0), (1, 2, '{}', 2000, 0)").run()
    await applyD1Migrations(legacy, env.TEST_MIGRATIONS.slice(0, 3))
    await legacy.prepare("INSERT INTO attachment_provider_files (id, attachment_id, provider_id, credential_version, file_family, base_url, provider_reference, expires_at, cleanup_after, cleanup_attempts, last_cleanup_error, created_at) VALUES (3, 1, 1, 2, 'openai', 'https://api.openai.com/v1', '{\"openai\":\"pending-old-upload\"}', 2000, 5000, 4, 'Provider file deletion failed (HTTP 503)', 1000)").run()
    await legacy.prepare("UPDATE models SET metadata_override = '{\"cost\":null,\"reasoning\":false}', metadata_resolved = '{\"cost\":null,\"reasoning\":false}', search_name = 'vertex preserved', enabled = 1 WHERE id = 2").run()
    await applyD1Migrations(legacy, env.TEST_MIGRATIONS)
    const db = createDb(legacy)
    const migrated = await db.select().from(providers).where(eq(providers.id, 1))
    expect(migrated[0]).toMatchObject({ api_key: 'encrypted-value', credential_version: 1, models_dev_provider_id: 'openai', models_dev_provider_source: 'manual' })
    const vertex = await legacy.prepare('SELECT enabled, default_interface_id, api_key FROM providers WHERE id = 2').first()
    expect(vertex).toEqual({ enabled: 0, default_interface_id: null, api_key: 'vertex-key' })
    expect(await legacy.prepare('SELECT models_dev_provider_id, models_dev_provider_source FROM providers WHERE id = 4').first()).toEqual({ models_dev_provider_id: 'anthropic', models_dev_provider_source: 'endpoint' })
    expect(await legacy.prepare('SELECT models_dev_provider_id, models_dev_provider_source FROM providers WHERE id = 5').first()).toEqual({ models_dev_provider_id: null, models_dev_provider_source: 'endpoint' })
    const interfaces = await legacy.prepare('SELECT provider_id, protocol, native_files FROM provider_interfaces ORDER BY provider_id').all()
    expect(interfaces.results).toEqual([
      { provider_id: 1, protocol: 'responses', native_files: 1 }, { provider_id: 3, protocol: 'vertex-compatible', native_files: 0 },
      { provider_id: 4, protocol: 'anthropic', native_files: 0 }, { provider_id: 5, protocol: 'chat-completions', native_files: 0 },
    ])
    const model = await legacy.prepare('SELECT metadata_override, metadata_resolved, supports_image_input, supports_image_output, supports_reasoning, supports_tools FROM models WHERE id = 1').first<{ metadata_override: string; metadata_resolved: string; supports_image_input: number; supports_image_output: number; supports_reasoning: number; supports_tools: number }>()
    expect(JSON.parse(model!.metadata_override)).toEqual({ name: 'Custom Name', reasoning: false, tool_call: true, modalities: { input: ['text'], output: ['text', 'image'] }, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'ultra'] }], cost: { input: 0, output: 2, cache_read: 0 } })
    expect(JSON.parse(model!.metadata_resolved)).toEqual(JSON.parse(model!.metadata_override))
    expect(model).toMatchObject({ supports_image_input: 0, supports_image_output: 1, supports_reasoning: 0, supports_tools: 1 })
    expect(await legacy.prepare("SELECT metadata_override, metadata_resolved, enabled, interface_id FROM models WHERE id = 2").first()).toEqual({ metadata_override: '{"cost":null,"reasoning":false}', metadata_resolved: '{"cost":null,"reasoning":false}', enabled: 1, interface_id: null })
    expect(await legacy.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'ustom'").first('rowid')).toBe(1)
    expect(await legacy.prepare('SELECT file_family, base_url, cleanup_after, credential_version FROM attachment_provider_files WHERE id = 1').first()).toEqual({ file_family: 'openai', base_url: 'https://api.openai.com/v1', cleanup_after: 1000, credential_version: 1 })
    expect(await legacy.prepare('SELECT credential_version, provider_reference, expires_at, cleanup_after, cleanup_attempts, last_cleanup_error FROM attachment_provider_files WHERE id = 3').first()).toEqual({ credential_version: 2, provider_reference: '{"openai":"pending-old-upload"}', expires_at: 2000, cleanup_after: 5000, cleanup_attempts: 4, last_cleanup_error: 'Provider file deletion failed (HTTP 503)' })
    expect(await legacy.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'reserved'").first('rowid')).toBe(2)
    expect(await legacy.prepare('SELECT id FROM attachment_provider_files WHERE provider_id = 2').first()).toBeNull()
    const providerColumns = (await legacy.prepare('PRAGMA table_info(providers)').all<{ name: string }>()).results.map(row => row.name)
    for (const column of ['protocol', 'base_url', 'extra', 'native_files']) expect(providerColumns).not.toContain(column)
    const modelColumns = (await legacy.prepare('PRAGMA table_info(models)').all<{ name: string }>()).results.map(row => row.name)
    for (const column of ['display_name', 'capabilities', 'pricing']) expect(modelColumns).not.toContain(column)
    await expect(legacy.prepare("INSERT INTO attachment_provider_files (attachment_id, provider_id, provider_reference, expires_at, created_at) VALUES (1, 1, '{}', 1000, 0)").run()).rejects.toThrow()
    expect((await legacy.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})
