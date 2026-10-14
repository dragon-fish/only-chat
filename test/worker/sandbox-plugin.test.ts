import { env } from 'cloudflare:workers'
import { eq, isNotNull } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { sandboxBackups, users } from '@/server/db/schema'
import { createConversation } from '@/server/plugins/hub/conversations'
import { recordBackup } from '@/server/sandbox/backups'
import type { Unit } from '@/server/sandbox/protocol'
import { ensureTestUser } from './auth-helper'
import { connect } from './ws-helper'

const OTHER_USER = 2

async function freshDb(): Promise<DB> {
  const db = createDb(env.DB)
  await ensureTestUser(db)
  await db.insert(users).values({
    id: OTHER_USER, name: 'other', email: 'other@example.com', settings: { plugins: {} },
    createdAt: new Date(0), updatedAt: new Date(0),
  }).onConflictDoNothing()
  await db.delete(sandboxBackups)
  return db
}

async function seed(db: DB, userId: number, unit: Unit, backupId: string) {
  await recordBackup(db, userId, unit, { id: backupId, size: 1, sha256: 'x' }, 1)
}

async function deletedBackupIds(db: DB): Promise<string[]> {
  const rows = await db.select({ id: sandboxBackups.backup_id }).from(sandboxBackups)
    .where(isNotNull(sandboxBackups.deleted_at))
  return rows.map(row => row.id).sort()
}

describe('sandbox backups follow the lifetime of their unit', () => {
  let db: DB
  beforeEach(async () => { db = await freshDb() })

  it('marks only the deleted conversation\'s backups when it is deleted', async () => {
    const doomed = await createConversation(db, { user_id: 1, title: 'doomed', provider_id: null, model_id: null })
    const kept = await createConversation(db, { user_id: 1, title: 'kept', provider_id: null, model_id: null })
    await seed(db, 1, { kind: 'conversation', id: doomed.id }, 'doomed-1')
    await seed(db, 1, { kind: 'conversation', id: doomed.id }, 'doomed-2')
    await seed(db, 1, { kind: 'conversation', id: kept.id }, 'kept')
    await seed(db, 1, { kind: 'user', id: null }, 'user-unit')
    // Same unit id under another user must never be touched.
    await seed(db, OTHER_USER, { kind: 'conversation', id: doomed.id }, 'other-user')

    const client = await connect(await ensureTestUser())
    client.ws.send(JSON.stringify({ type: 'conversation.delete', request_id: 'del-1', conversation_id: doomed.id }))
    await client.next('conversation.deleted')

    expect(await deletedBackupIds(db)).toEqual(['doomed-1', 'doomed-2'])
  })

  it('marks only the deleted project\'s backups when it is deleted', async () => {
    const client = await connect(await ensureTestUser())
    const createProject = async (name: string, count: number) => {
      client.ws.send(JSON.stringify({ type: 'project.create', name }))
      const frame = await client.nextAfter('project.created', count) as { project: { id: number } }
      return frame.project.id
    }
    const doomed = await createProject('doomed', 1)
    const kept = await createProject('kept', 2)
    await seed(db, 1, { kind: 'project', id: doomed }, 'doomed')
    await seed(db, 1, { kind: 'project', id: kept }, 'kept')
    // A conversation sharing the project's numeric id is a different unit.
    await seed(db, 1, { kind: 'conversation', id: doomed }, 'same-id-conversation')
    await seed(db, 1, { kind: 'user', id: null }, 'user-unit')
    await seed(db, OTHER_USER, { kind: 'project', id: doomed }, 'other-user')

    client.ws.send(JSON.stringify({ type: 'project.delete', project_id: doomed }))
    await client.next('project.deleted')

    // `project/deleted` is a fire-and-forget event, so the marking lands shortly after the frame.
    await vi.waitFor(async () => expect(await deletedBackupIds(db)).toEqual(['doomed']))
    const live = await db.select({ id: sandboxBackups.backup_id }).from(sandboxBackups)
      .where(eq(sandboxBackups.user_id, 1))
    expect(live).toHaveLength(4)
  })
})
