import { and, desc, eq, inArray, isNotNull, isNull, lt, type SQL } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { sandboxBackups, type SandboxBackupRow } from '@/server/db/schema'
import { TRASH_RETENTION_MS } from '@/server/plugins/workspace-files/service'
import { BACKUP_PREFIX, BACKUPS_KEPT, type Unit } from './protocol'

export interface StoredBackup {
  id: number
  backupId: string
  r2Key: string
  sha256: string
  size: number
  createdAt: number
}

/** `${BACKUP_PREFIX}${backupId}.tar.zst` — the object key DirectoryBackup writes. */
export function backupR2Key(backupId: string): string {
  return `${BACKUP_PREFIX}${backupId}.tar.zst`
}

function toStored(row: SandboxBackupRow): StoredBackup {
  return {
    id: row.id,
    backupId: row.backup_id,
    r2Key: row.r2_key,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.created_at,
  }
}

// The user unit has a NULL id, which `eq` cannot match.
function unitWhere(userId: number, unit: Unit): SQL {
  const id = unit.id === null ? isNull(sandboxBackups.unit_id) : eq(sandboxBackups.unit_id, unit.id)
  return and(eq(sandboxBackups.user_id, userId), eq(sandboxBackups.unit_kind, unit.kind), id)!
}

function liveWhere(userId: number, unit: Unit): SQL {
  return and(unitWhere(userId, unit), isNull(sandboxBackups.deleted_at))!
}

/** Newest backup of the unit that is not deleted, or null. */
export async function latestBackup(db: DB, userId: number, unit: Unit): Promise<StoredBackup | null> {
  const [row] = await db.select().from(sandboxBackups)
    .where(liveWhere(userId, unit))
    .orderBy(desc(sandboxBackups.created_at), desc(sandboxBackups.id))
    .limit(1)
  return row ? toStored(row) : null
}

/** Inserts a row for a finished backup. */
export async function recordBackup(
  db: DB,
  userId: number,
  unit: Unit,
  record: { id: string, size: number, sha256: string },
  now: number,
): Promise<StoredBackup> {
  const [row] = await db.insert(sandboxBackups).values({
    user_id: userId,
    unit_kind: unit.kind,
    unit_id: unit.id,
    backup_id: record.id,
    r2_key: backupR2Key(record.id),
    sha256: record.sha256,
    size: record.size,
    created_at: now,
  }).returning()
  return toStored(row)
}

/**
 * Keeps the newest `keep` non-deleted backups of the unit; older ones lose their R2 object and then
 * their row. A failed R2 delete keeps that row so the next rotation retries it.
 */
export async function rotateBackups(
  db: DB,
  bucket: R2Bucket,
  userId: number,
  unit: Unit,
  keep = BACKUPS_KEPT,
): Promise<number> {
  const rows = await db.select().from(sandboxBackups)
    .where(liveWhere(userId, unit))
    .orderBy(desc(sandboxBackups.created_at), desc(sandboxBackups.id))
  let removed = 0
  for (const row of rows.slice(keep)) {
    try {
      await bucket.delete(row.r2_key)
    } catch {
      continue
    }
    await db.delete(sandboxBackups).where(and(eq(sandboxBackups.id, row.id), eq(sandboxBackups.user_id, userId)))
    removed++
  }
  return removed
}

/** Marks every non-deleted backup of the unit deleted. Returns the count. */
export async function markUnitBackupsDeleted(db: DB, userId: number, unit: Unit, now: number): Promise<number> {
  const rows = await db.update(sandboxBackups)
    .set({ deleted_at: now })
    .where(liveWhere(userId, unit))
    .returning({ id: sandboxBackups.id })
  return rows.length
}

/**
 * Nightly, across all users: rows deleted longer than `retentionMs` ago lose their R2 object, then
 * the row. A failed R2 delete keeps the row for the next night.
 */
export async function sweepSandboxBackups(
  db: DB,
  bucket: R2Bucket,
  now: number,
  retentionMs = TRASH_RETENTION_MS,
): Promise<{ backups: number, bytes: number }> {
  const expired = await db.select().from(sandboxBackups)
    .where(and(isNotNull(sandboxBackups.deleted_at), lt(sandboxBackups.deleted_at, now - retentionMs)))
  let backups = 0
  let bytes = 0
  for (const row of expired) {
    try {
      await bucket.delete(row.r2_key)
    } catch {
      continue
    }
    await db.delete(sandboxBackups).where(inArray(sandboxBackups.id, [row.id]))
    backups++
    bytes += row.size
  }
  return { backups, bytes }
}
