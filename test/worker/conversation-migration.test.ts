import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { expect, it } from 'vitest'

it('renames legacy chat storage while preserving branches, tool snapshots and foreign keys', async () => {
  const migrated = env.TEST_LEGACY_DB
  const migration = env.TEST_MIGRATIONS.find(entry => entry.name === '0007_conversations.sql')
  expect(migration).toBeDefined()
  await applyD1Migrations(migrated, env.TEST_MIGRATIONS.filter(entry => entry.name < '0007_conversations.sql'))
  await migrated.prepare("INSERT INTO users (id, name, settings, created_at) VALUES (1, 'owner', '{}', 0)").run()
  await migrated.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (3, 1, 'project', 0, 0)").run()
  // Historical SQL must use the pre-migration table and column names.
  await migrated.prepare("INSERT INTO sessions (id, user_id, project_id, title, head_message_id, tools, created_at, updated_at) VALUES (7, 1, 3, 'legacy', 12, '[\"ask_user\"]', 0, 1)").run()
  for (const [id, parent, seq, role] of [[10, null, 1, 'user'], [11, 10, 2, 'assistant'], [12, 10, 3, 'assistant']] as const) {
    await migrated.prepare("INSERT INTO messages (id, session_id, parent_id, seq, role, parts, status, created_at) VALUES (?, 7, ?, ?, ?, '[]', 'done', 0)").bind(id, parent, seq, role).run()
  }
  await applyD1Migrations(migrated, [migration!])

  const tables = await migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>()
  expect(tables.results.map(row => row.name)).toContain('conversations')
  expect(tables.results.map(row => row.name)).not.toContain('sessions')
  expect(await migrated.prepare('SELECT * FROM conversations WHERE id = 7').first())
    .toMatchObject({ id: 7, user_id: 1, project_id: 3, title: 'legacy', head_message_id: 12, tools: '["ask_user"]', created_at: 0, updated_at: 1 })
  expect((await migrated.prepare('SELECT id, conversation_id, parent_id, seq FROM messages ORDER BY seq').all()).results).toEqual([
    { id: 10, conversation_id: 7, parent_id: null, seq: 1 },
    { id: 11, conversation_id: 7, parent_id: 10, seq: 2 },
    { id: 12, conversation_id: 7, parent_id: 10, seq: 3 },
  ])
  expect((await migrated.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
  await expect(migrated.prepare("INSERT INTO messages (conversation_id, seq, role, parts, status, created_at) VALUES (7, 3, 'user', '[]', 'done', 0)").run()).rejects.toThrow(/UNIQUE/)
  await expect(migrated.prepare("INSERT INTO messages (conversation_id, seq, role, parts, status, created_at) VALUES (999, 1, 'user', '[]', 'done', 0)").run()).rejects.toThrow(/FOREIGN KEY/)
  await migrated.prepare('DELETE FROM projects WHERE id = 3').run()
  expect(await migrated.prepare('SELECT project_id FROM conversations WHERE id = 7').first()).toEqual({ project_id: null })
  await migrated.prepare('DELETE FROM conversations WHERE id = 7').run()
  expect((await migrated.prepare('SELECT * FROM messages').all()).results).toEqual([])
})
