import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '@/server/db/client'
import { sandboxBackups, users } from '@/server/db/schema'
import { TRASH_RETENTION_MS } from '@/server/plugins/workspace-files/service'
import {
  backupR2Key, latestBackup, markUnitBackupsDeleted, recordBackup, rotateBackups, sweepSandboxBackups,
} from '@/server/sandbox/backups'
import type { Unit } from '@/server/sandbox/protocol'

const USER: Unit = { kind: 'user', id: null }
const project = (id: number): Unit => ({ kind: 'project', id })
const conversation = (id: number): Unit => ({ kind: 'conversation', id })

let db: DB

async function seedUsers() {
  for (const id of [1, 2]) {
    await db.insert(users).values({
      id, name: `u${id}`, email: `u${id}@example.com`, settings: { plugins: {} },
      createdAt: new Date(0), updatedAt: new Date(0),
    }).onConflictDoNothing()
  }
}

/** Records a backup and puts a real object at its key. */
async function backup(userId: number, unit: Unit, id: string, now: number) {
  await env.BUCKET.put(backupR2Key(id), 'x')
  return recordBackup(db, userId, unit, { id, size: 10, sha256: 'h' }, now)
}

const exists = async (id: string) => (await env.BUCKET.head(backupR2Key(id))) !== null

beforeEach(async () => {
  db = createDb(env.DB)
  await db.delete(sandboxBackups)
  await seedUsers()
})

describe('latestBackup', () => {
  it('matches the exact unit of the exact user, newest first, skipping deleted rows', async () => {
    await backup(1, USER, 'u-old', 1)
    await backup(1, project(5), 'p5', 50)
    await backup(1, conversation(5), 'c5', 60)
    await backup(2, USER, 'other-user', 70)
    const newest = await backup(1, USER, 'u-new', 2)

    expect((await latestBackup(db, 1, USER))?.backupId).toBe('u-new')
    expect((await latestBackup(db, 1, project(5)))?.backupId).toBe('p5')
    expect((await latestBackup(db, 1, conversation(5)))?.backupId).toBe('c5')
    expect(await latestBackup(db, 1, project(6))).toBeNull()
    expect((await latestBackup(db, 2, USER))?.backupId).toBe('other-user')

    await db.update(sandboxBackups).set({ deleted_at: 9 }).where(eq(sandboxBackups.id, newest.id))
    expect((await latestBackup(db, 1, USER))?.backupId).toBe('u-old')
  })

  it('breaks created_at ties by highest id', async () => {
    await backup(1, USER, 'a', 5)
    await backup(1, USER, 'b', 5)
    expect((await latestBackup(db, 1, USER))?.backupId).toBe('b')
  })
})

describe('rotateBackups', () => {
  it('keeps the newest N, deleting older rows and objects, only within the unit', async () => {
    await backup(1, project(1), 'p-1', 1)
    await backup(1, project(1), 'p-2', 2)
    await backup(1, project(1), 'p-3', 3)
    await backup(1, project(2), 'q-1', 1)
    await backup(1, USER, 'u-1', 1)

    expect(await rotateBackups(db, env.BUCKET, 1, project(1), 2)).toBe(1)
    expect(await exists('p-1')).toBe(false)
    expect(await exists('p-2')).toBe(true)
    expect(await exists('p-3')).toBe(true)
    expect(await exists('q-1')).toBe(true)
    expect(await exists('u-1')).toBe(true)
    expect((await latestBackup(db, 1, project(1)))?.backupId).toBe('p-3')
  })

  it('keeps the row when the object delete fails and continues with the rest', async () => {
    await backup(1, USER, 'a', 1)
    await backup(1, USER, 'b', 2)
    await backup(1, USER, 'c', 3)
    const failing = {
      delete: async (key: string) => {
        if (key === backupR2Key('a')) throw new Error('boom')
        await env.BUCKET.delete(key)
      },
    } as unknown as R2Bucket

    expect(await rotateBackups(db, failing, 1, USER, 1)).toBe(1)
    expect(await exists('b')).toBe(false)
    const rows = await db.select().from(sandboxBackups).where(eq(sandboxBackups.user_id, 1))
    expect(rows.map(r => r.backup_id).sort()).toEqual(['a', 'c'])
  })
})

describe('markUnitBackupsDeleted and sweep', () => {
  it('marks only that unit of that user', async () => {
    await backup(1, project(1), 'p1', 1)
    await backup(1, project(2), 'p2', 1)
    await backup(2, project(1), 'other', 1)

    expect(await markUnitBackupsDeleted(db, 1, project(1), 100)).toBe(1)
    expect(await markUnitBackupsDeleted(db, 1, project(1), 200)).toBe(0)
    expect(await latestBackup(db, 1, project(1))).toBeNull()
    expect(await latestBackup(db, 1, project(2))).not.toBeNull()
    expect(await latestBackup(db, 2, project(1))).not.toBeNull()
  })

  it('sweeps only rows deleted past retention, with their objects', async () => {
    const now = 10 * TRASH_RETENTION_MS
    await backup(1, project(1), 'old', 1)
    await backup(1, project(2), 'recent', 1)
    await backup(2, project(3), 'live', 1)
    await markUnitBackupsDeleted(db, 1, project(1), now - TRASH_RETENTION_MS - 1)
    await markUnitBackupsDeleted(db, 1, project(2), now - TRASH_RETENTION_MS + 1)

    expect(await sweepSandboxBackups(db, env.BUCKET, now)).toEqual({ backups: 1, bytes: 10 })
    expect(await exists('old')).toBe(false)
    expect(await exists('recent')).toBe(true)
    expect(await exists('live')).toBe(true)
    const rows = await db.select().from(sandboxBackups)
    expect(rows.map(r => r.backup_id).sort()).toEqual(['live', 'recent'])
  })
})
