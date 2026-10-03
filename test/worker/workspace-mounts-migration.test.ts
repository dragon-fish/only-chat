import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { expect, it } from 'vitest'

const MIGRATION = '0021_workspace-mounts.sql'

it('gives every existing workspace file the mount its ids implied, orphans included', async () => {
  const db = env.TEST_LEGACY_DB
  const migration = env.TEST_MIGRATIONS.find(entry => entry.name === MIGRATION)
  expect(migration).toBeDefined()
  await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(entry => entry.name < MIGRATION))
  await db.prepare("INSERT INTO users (id, name, settings, created_at) VALUES (1, 'owner', '{}', 0)").run()
  await db.prepare("INSERT INTO projects (id, user_id, name, created_at, updated_at) VALUES (3, 1, 'project', 0, 0)").run()
  await db.prepare("INSERT INTO conversations (id, user_id, project_id, title, tools, created_at, updated_at) VALUES (7, 1, 3, 'c', '[]', 0, 0)").run()
  const insert = 'INSERT INTO workspace_files (id, user_id, project_id, conversation_id, relative_path, created_at, updated_at, deleted_at) VALUES (?, 1, ?, ?, ?, 0, 0, ?)'
  await db.prepare(insert).bind(1, 3, null, 'shared.md', null).run()
  await db.prepare(insert).bind(2, null, 7, 'own.md', null).run()
  await db.prepare(insert).bind(3, null, null, 'orphan.md', 0).run()

  await applyD1Migrations(db, [migration!])

  const rows = await db.prepare('SELECT id, mount FROM workspace_files ORDER BY id').all()
  expect(rows.results).toEqual([
    { id: 1, mount: 'project' }, { id: 2, mount: 'conversation' }, { id: 3, mount: 'conversation' },
  ])
  // The same name may now live in a Project and in that Project's memory.
  await db.prepare("INSERT INTO workspace_files (user_id, project_id, mount, relative_path, created_at, updated_at) VALUES (1, 3, 'memory/project', 'shared.md', 0, 0)").run()
  await expect(db.prepare("INSERT INTO workspace_files (user_id, project_id, mount, relative_path, created_at, updated_at) VALUES (1, 3, 'project', 'shared.md', 0, 0)").run()).rejects.toThrow(/UNIQUE/)
})
