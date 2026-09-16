import { and, eq, gt } from 'drizzle-orm'
import type { DB } from '@/server/db/client'
import { authSessions, users } from '@/server/db/schema'

export const INTERNAL_USER_ID_HEADER = 'X-Only-Chat-User-Id'
export const INTERNAL_AUTH_SESSION_ID_HEADER = 'X-Only-Chat-Auth-Session-Id'
export const USER_ID_STORAGE_KEY = 'identity:user-id'
/** Survives hibernation: the in-memory field does not, and a woken DO has no request to re-read. */
export const ORIGIN_STORAGE_KEY = 'identity:origin'
export const AUTH_REVOKED_PATH = '/internal/auth-revoked'
export const AUTH_REVOKED_CLOSE_CODE = 4001

export interface SocketAttachment { authSessionId: string }

export async function hasActiveAuthSession(db: DB, userId: number, authSessionId: unknown): Promise<boolean> {
  if (typeof authSessionId !== 'string' || authSessionId.length === 0) return false
  const [authSession] = await db.select({ id: authSessions.id }).from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(authSessions.id, authSessionId), eq(authSessions.userId, userId),
      gt(authSessions.expiresAt, new Date()), eq(users.banned, false))).limit(1)
  return authSession !== undefined
}
