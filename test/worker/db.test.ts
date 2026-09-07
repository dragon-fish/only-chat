import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, messages, projects, providers, sessions, users } from '@/server/db/schema'
import { getProviderFile } from '@/server/plugins/hub/sessions'

describe('D1 schema', () => {
  it('inserts a session and a message tree', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const [u] = await db.insert(messages).values({
      session_id: s!.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hi' }],
      provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 2,
    }).returning()
    const [a] = await db.insert(messages).values({
      session_id: s!.id, parent_id: u!.id, seq: 2, role: 'assistant', parts: [],
      provider_id: null, model_id: 'm', usage: { prompt: 1, completion: 0 }, status: 'error', error: null, created_at: 3,
    }).returning()
    const rows = await db.select().from(messages).where(eq(messages.session_id, s!.id)).orderBy(messages.seq)
    expect(rows.map((r) => r.id)).toEqual([u!.id, a!.id])
    expect(rows[1]!.usage).toEqual({ prompt: 1, completion: 0 })
    expect(rows[0]!.parts).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('enforces unique (session_id, seq)', async () => {
    const db = createDb(env.DB)
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't2', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    const row = {
      session_id: s!.id, parent_id: null, seq: 1, role: 'user' as const, parts: [],
      provider_id: null, model_id: null, usage: null, status: 'done' as const, error: null, created_at: 0,
    }
    await db.insert(messages).values(row)
    await expect(db.insert(messages).values(row)).rejects.toThrow()
  })

  it('creates a project with only name required, and defaults provider native_files to false', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(projects).values({
      user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null,
      params: null, created_at: 1, updated_at: 1,
    }).returning()
    expect(p!.name).toBe('Design')

    const [provider] = await db.insert(providers).values({
      user_id: 1, name: 'p1', protocol: 'openai-completions', base_url: 'https://api.example.com', created_at: 0,
    }).returning()
    expect(provider!.native_files).toBe(false)
  })

  it('sets session.project_id to null when its Project is deleted', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(projects).values({
      user_id: 1, name: 'Design', system_prompt: null, provider_id: null, model_id: null,
      params: null, created_at: 1, updated_at: 1,
    }).returning()
    const [s] = await db.insert(sessions).values({
      user_id: 1, title: 't3', head_message_id: null, provider_id: null, model_id: null,
      system_prompt: null, params: null, project_id: p!.id, created_at: 1, updated_at: 1, archived_at: null,
    }).returning()
    expect(s!.project_id).toBe(p!.id)

    await db.delete(projects).where(eq(projects.id, p!.id))
    const [reloaded] = await db.select().from(sessions).where(eq(sessions.id, s!.id))
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
      user_id: 1, name: 'p1', protocol: 'openai-completions', base_url: 'https://api.example.com', created_at: 0,
    }).returning()
    const [p2] = await db.insert(providers).values({
      user_id: 1, name: 'p2', protocol: 'anthropic', base_url: 'https://api.example.com', created_at: 0,
    }).returning()

    await db.insert(attachmentProviderFiles).values({
      attachment_id: a!.id, provider_id: p1!.id, provider_reference: { openai: 'file-1' },
      expires_at: 1000, created_at: 0,
    })
    await db.insert(attachmentProviderFiles).values({
      attachment_id: a!.id, provider_id: p2!.id, provider_reference: { anthropic: 'file-2' },
      expires_at: 1000, created_at: 0,
    })
    const rows = await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))
    expect(rows).toHaveLength(2)

    await db.insert(attachmentProviderFiles).values({
      attachment_id: a!.id, provider_id: p1!.id, provider_reference: { openai: 'file-3' },
      expires_at: 2000, created_at: 0,
    })
    expect(await db.select().from(attachmentProviderFiles).where(eq(attachmentProviderFiles.attachment_id, a!.id))).toHaveLength(3)
    expect((await getProviderFile(db, a!.id, p1!.id))!.provider_reference).toEqual({ openai: 'file-3' })
    expect((await getProviderFile(db, a!.id, p2!.id))!.provider_reference).toEqual({ anthropic: 'file-2' })
  })

  it('stores two interfaces and rejects duplicate protocols and dangling interface references', async () => {
    const db = createDb(env.DB)
    await db.insert(users).values({ id: 1, name: 'owner', settings: { plugins: {} }, created_at: 0 }).onConflictDoNothing()
    const [p] = await db.insert(providers).values({ user_id: 1, name: 'interfaces', protocol: 'openai-responses', base_url: 'https://example.com/v1', created_at: 0 }).returning()
    const insert = (protocol: string) => env.DB.prepare('INSERT INTO provider_interfaces (provider_id, protocol, base_url, created_at) VALUES (?, ?, ?, 0)').bind(p!.id, protocol, 'https://example.com/v1').run()
    const response = await insert('responses')
    await insert('chat-completions')
    await expect(insert('responses')).rejects.toThrow()
    await expect(insert('vertex')).rejects.toThrow()
    await expect(env.DB.prepare("INSERT INTO provider_interfaces (provider_id, protocol, base_url, native_files, created_at) VALUES (?, 'vertex-compatible', 'https://example.com', 1, 0)").bind(p!.id).run()).rejects.toThrow()
    await env.DB.prepare('UPDATE providers SET default_interface_id = ? WHERE id = ?').bind(response.meta.last_row_id, p!.id).run()
    await expect(env.DB.prepare('UPDATE providers SET default_interface_id = -1 WHERE id = ?').bind(p!.id).run()).rejects.toThrow()
    await expect(env.DB.prepare("INSERT INTO models (provider_id, model_id, display_name, capabilities, interface_id) VALUES (?, 'dangling', 'Dangling', '{}', -1)").bind(p!.id).run()).rejects.toThrow()
    await env.DB.prepare("INSERT INTO models (provider_id, model_id, display_name, capabilities, interface_id) VALUES (?, 'valid', 'Valid', '{}', ?)").bind(p!.id, response.meta.last_row_id).run()
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
    const [p] = await db.insert(providers).values({ user_id: 1, name: 'fts', protocol: 'anthropic', base_url: 'https://example.com', created_at: 0 }).returning()
    const inserted = await env.DB.prepare("INSERT INTO models (provider_id, model_id, display_name, capabilities, search_name, metadata_resolved, metadata_override) VALUES (?, 'search-model', 'Search', '{}', 'claude opus', ?, ?)")
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
    expect(await legacy.prepare("SELECT metadata_override FROM models WHERE id = 2").first('metadata_override')).toBe('{}')
    expect(await legacy.prepare("SELECT rowid FROM models_fts WHERE models_fts MATCH 'ustom'").first('rowid')).toBe(1)
    expect(await legacy.prepare('SELECT file_family, base_url, cleanup_after, credential_version FROM attachment_provider_files WHERE provider_id = 1').first()).toEqual({ file_family: 'openai', base_url: 'https://api.openai.com/v1', cleanup_after: 1000, credential_version: 1 })
    expect(await legacy.prepare('SELECT file_family, expires_at, cleanup_after FROM attachment_provider_files WHERE provider_id = 2').first()).toEqual({ file_family: null, expires_at: 0, cleanup_after: 0 })
    expect((await legacy.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  })
})
