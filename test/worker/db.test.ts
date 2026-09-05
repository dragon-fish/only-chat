import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { attachmentProviderFiles, attachments, messages, projects, providers, sessions, users } from '@/server/db/schema'

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

  it('isolates attachment provider file pointers per provider, one per (attachment_id, provider_id)', async () => {
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

    await expect(db.insert(attachmentProviderFiles).values({
      attachment_id: a!.id, provider_id: p1!.id, provider_reference: { openai: 'file-3' },
      expires_at: 2000, created_at: 0,
    })).rejects.toThrow()
  })
})
