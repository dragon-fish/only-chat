import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { authSessions, conversations, users } from '@/server/db/schema'
import { setAllowRegister } from './auth-helper'

describe('authentication foundation', () => {
  it('does not create a default user at startup', async () => {
    const app = await createApp({ env, side: 'worker' })
    expect(await app.db.orm.select().from(users)).toEqual([])
  })

  it('uses distinct authentication table names', () => {
    expect(getTableName(conversations)).toBe('conversations')
    expect(getTableName(authSessions)).toBe('auth_sessions')
  })

  it('signs up with database-generated user IDs and persists string credential and session IDs', async () => {
    await setAllowRegister(true)
    const app = await createApp({ env, side: 'worker' })
    const result = await app.auth.instance.api.signUpEmail({ body: { name: 'First', email: 'first@example.com', password: 'a-long-test-password' } })
    expect(result.user.id).toBe('1')
    const stored = await env.DB.prepare('SELECT id, email, settings FROM users').first()
    expect(stored).toEqual({ id: 1, email: 'first@example.com', settings: '{"plugins":{}}' })
    const account = await env.DB.prepare('SELECT id, user_id, provider_id FROM auth_accounts').first()
    expect(account).toMatchObject({ id: expect.any(String), user_id: 1, provider_id: 'credential' })
    expect(await env.DB.prepare('SELECT id, user_id FROM auth_sessions').first()).toEqual({ id: expect.any(String), user_id: 1 })
    expect(await app.auth.instance.api.userHasPermission({ body: { userId: '1', permissions: { user: ['list'] } } })).toEqual({ success: true, error: null })
  })

  it('extends legacy users without changing IDs, settings, or dependent rows', async () => {
    const db = env.TEST_LEGACY_DB
    const authIndex = env.TEST_MIGRATIONS.findIndex(m => m.name === '0008_user-auth.sql')
    expect(authIndex).toBeGreaterThan(0)
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, authIndex))
    await db.prepare(`INSERT INTO users (id, name, settings, created_at) VALUES (1, 'Owner', '{"plugins":{"ask_user":true}}', 123), (7, 'Other', '{"plugins":{}}', 456)`).run()
    await db.prepare("INSERT INTO providers (id, user_id, name, created_at) VALUES (11, 1, 'Provider', 123)").run()
    await db.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (12, 1, 'Project', 123, 123)").run()
    await db.prepare("INSERT INTO conversations (id, user_id, project_id, title, created_at, updated_at) VALUES (13, 1, 12, 'Chat', 123, 123)").run()
    await db.prepare("INSERT INTO attachments (id, user_id, sha256, mime, size, r2_key, origin, created_at) VALUES (14, 1, 'hash', 'text/plain', 1, 'key', 'upload', 123)").run()
    await applyD1Migrations(db, env.TEST_MIGRATIONS)
    expect((await db.prepare('SELECT * FROM users ORDER BY id').all()).results).toEqual([
      { id: 1, name: 'Owner', settings: '{"plugins":{"ask_user":true}}', enabled_models_revision: 1, created_at: 123, email: 'legacy-user-1@invalid.local', email_verified: 0, image: null, role: 'user', banned: 0, ban_reason: null, ban_expires: null, updated_at: 123 },
      { id: 7, name: 'Other', settings: '{"plugins":{}}', enabled_models_revision: 1, created_at: 456, email: 'legacy-user-7@invalid.local', email_verified: 0, image: null, role: 'user', banned: 0, ban_reason: null, ban_expires: null, updated_at: 456 },
    ])
    for (const [table, id] of [['providers', 11], ['projects', 12], ['conversations', 13], ['attachments', 14]] as const) {
      expect(await db.prepare(`SELECT id, user_id FROM ${table}`).first()).toEqual({ id, user_id: 1 })
    }
    expect((await db.prepare('SELECT * FROM auth_accounts').all()).results).toEqual([])
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    await expect(db.prepare("UPDATE users SET email = 'legacy-user-1@invalid.local' WHERE id = 7").run()).rejects.toThrow()
  })
})
