import type { Hub } from '@/server/plugins/hub'
import { acquireSession, listSessions, type BrowserBinding } from './browser-api'

/** What the Durable Object remembers about a conversation's browser between calls. */
export interface StoredSession {
  sessionId: string
  startedAt: number
  keepAliveMs: number
  liveView: { url: string; expiresAt: number } | null
}

const KEY_PREFIX = 'browser:'

/**
 * What a probe leaves stored. A probe that could not even connect means the platform has dropped
 * the session — the list it was found in lags a little behind — and keeping the record would hand
 * the panel a Live View link to a browser that is gone.
 */
export function probedSession(session: StoredSession, result: { ok: boolean; liveView: StoredSession['liveView'] }): StoredSession | undefined {
  if (!result.ok) return undefined
  return { ...session, liveView: result.liveView ?? session.liveView }
}

/**
 * One browser per conversation, one connection at a time. The lock is what makes the second half
 * true: Browser Run refuses a second client on a session, so a run, a Live View refresh and a
 * profile export must never overlap on the same conversation.
 */
export class BrowserSessions {
  private readonly locks = new Map<number, Promise<unknown>>()

  constructor(private readonly hub: Hub, private readonly binding: BrowserBinding) {}

  get(conversationId: number): Promise<StoredSession | undefined> {
    return this.hub.state.storage.get<StoredSession>(`${KEY_PREFIX}${conversationId}`)
  }

  async put(conversationId: number, session: StoredSession): Promise<void> {
    await this.hub.state.storage.put(`${KEY_PREFIX}${conversationId}`, session)
  }

  async forget(conversationId: number): Promise<void> {
    await this.hub.state.storage.delete(`${KEY_PREFIX}${conversationId}`)
  }

  /** Serialises browser access per conversation; other conversations are unaffected. */
  withLock<T>(conversationId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(conversationId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.locks.set(conversationId, next)
    void next.catch(() => {}).finally(() => {
      if (this.locks.get(conversationId) === next) this.locks.delete(conversationId)
    })
    return next
  }

  /**
   * The stored session if the platform still has it, else a new one. A session dies after its
   * idle window or a platform release, so "stored" and "alive" are different questions.
   */
  async ensure(conversationId: number, keepAliveMs: number): Promise<{ session: StoredSession; fresh: boolean }> {
    const stored = await this.get(conversationId)
    if (stored) {
      const alive = (await listSessions(this.binding)).some(session => session.sessionId === stored.sessionId)
      if (alive) return { session: stored, fresh: false }
    }
    const { sessionId } = await acquireSession(this.binding, keepAliveMs)
    const session: StoredSession = { sessionId, startedAt: Date.now(), keepAliveMs, liveView: null }
    await this.put(conversationId, session)
    return { session, fresh: true }
  }

  /** Whether the stored session is still alive, without creating one. */
  async alive(conversationId: number): Promise<StoredSession | undefined> {
    const stored = await this.get(conversationId)
    if (!stored) return undefined
    const alive = (await listSessions(this.binding)).some(session => session.sessionId === stored.sessionId)
    if (alive) return stored
    await this.forget(conversationId)
    return undefined
  }
}
