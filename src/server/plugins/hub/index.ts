import { Context, Service } from 'cordis'
import { ZodError } from 'zod'
import type { DB } from '../../db/client'
import { DEFAULT_USER_ID, GENERATION_TIMEOUT_MS } from '@/shared/constants'
import type { Message, Session, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { encodeEvent, parseCommand, type WsCommand, type WsEvent } from '@/shared/ws'
import {
  deleteSession, finalizeMessage, getMessage, getSession, getUser, toMessage, updateSession, updateUserSettings,
} from './sessions'
import { SeqAllocator } from './seq'
import { runEdit, runRegenerate, runSend } from './generation'

export interface InflightJob {
  message: Message
  sessionId: number
  controller: AbortController
  startedAt: number
  parts: Part[]
  /** Resolves once the job untracked itself. Assigned by `trackInflight`; awaited by `stop`. */
  settled: Promise<void>
}

interface StoredInflight {
  message: Message
  parts: Part[]
  startedAt: number
}

const INFLIGHT_PREFIX = 'inflight:'
/** How long `stop()` waits for aborted generations to unwind before giving up on them. */
const STOP_TIMEOUT_MS = 5000
/** Re-arm delay when jobs are still tracked but all of them already timed out. */
const ALARM_WATCHDOG_MS = 60_000

export class Hub extends Service {
  static readonly provide = 'hub'
  static readonly inject = ['env', 'doState', 'db', 'assets', 'llm']

  /** Owning context (this.ctx inside methods is the caller's context, per cordis semantics). */
  readonly app: Context
  readonly state: DurableObjectState
  readonly db: DB
  readonly seq = new SeqAllocator()
  private readonly _inflight = new Map<number, InflightJob>()
  private readonly _settlers = new Map<number, () => void>()

  constructor(ctx: Context) {
    super(ctx, 'hub')
    this.app = ctx
    this.state = ctx.doState
    this.db = ctx.db.orm
  }

  async [Service.init]() {
    await this._recoverInflight()
  }

  // ---- sockets

  broadcast(event: WsEvent): void {
    const raw = encodeEvent(event)
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(raw)
      } catch (err) {
        console.warn('ws send failed', err)
      }
    }
  }

  handleConnect(ws: WebSocket): void {
    ws.send(encodeEvent({ type: 'snapshot', inflight: this.inflight().map((j) => ({ ...j.message, parts: j.parts })) }))
  }

  async handleCommand(raw: string): Promise<void> {
    let cmd: WsCommand
    try {
      cmd = parseCommand(raw)
    } catch (err) {
      const requestId = safeRequestId(raw)
      this.broadcast({
        type: 'error',
        request_id: requestId,
        message: err instanceof ZodError ? 'invalid command' : 'malformed json',
      })
      return
    }
    try {
      await this._dispatch(cmd)
    } catch (err) {
      console.error('command failed', cmd.type, err)
      this.broadcast({ type: 'error', request_id: cmd.request_id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async _dispatch(cmd: WsCommand): Promise<void> {
    switch (cmd.type) {
      case 'send': return runSend(this, cmd)
      case 'regenerate': return runRegenerate(this, cmd)
      case 'edit': return runEdit(this, cmd)
      case 'stop': return this.stop(cmd.session_id)
      case 'switch_head': return this.switchHead(cmd.session_id, cmd.message_id)
      case 'session.update': return this.sessionUpdate(cmd)
      case 'session.delete': return this.sessionDelete(cmd.session_id)
      case 'settings.update': return this.settingsUpdate(cmd.settings)
    }
  }

  // ---- non-generation commands

  /**
   * Aborts the session's generations and waits for them to unwind, so a caller like `sessionDelete`
   * can touch the rows right afterwards. `generation.ts` must always call `untrackInflight()` from
   * its finally path; otherwise a job only settles through the timeout below.
   */
  async stop(sessionId: number): Promise<void> {
    const settled: Promise<void>[] = []
    for (const job of this._inflight.values()) {
      if (job.sessionId !== sessionId) continue
      job.controller.abort('user stopped')
      settled.push(job.settled)
    }
    if (settled.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(settled).then(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async switchHead(sessionId: number, messageId: number): Promise<void> {
    const m = await getMessage(this.db, messageId)
    if (!m || m.session_id !== sessionId) throw new Error('message not in session')
    const s = await updateSession(this.db, sessionId, { head_message_id: messageId })
    this.broadcast({ type: 'head.changed', session_id: sessionId, message_id: messageId })
    this.emitSessionUpdated(s)
  }

  async sessionUpdate(cmd: Extract<WsCommand, { type: 'session.update' }>): Promise<void> {
    const { type: _t, request_id: _r, session_id, ...patch } = cmd
    if (!(await getSession(this.db, session_id))) throw new Error('session not found')
    const s = await updateSession(this.db, session_id, patch)
    this.emitSessionUpdated(s)
  }

  async sessionDelete(sessionId: number): Promise<void> {
    await this.stop(sessionId)
    await deleteSession(this.db, sessionId)
    this.seq.forget(sessionId)
    this.broadcast({ type: 'session.deleted', session_id: sessionId })
    this.app.emit('session/deleted', sessionId)
  }

  async settingsUpdate(patch: { plugins?: Record<string, boolean> }): Promise<void> {
    const user = await getUser(this.db, DEFAULT_USER_ID)
    if (!user) throw new Error('user missing')
    const settings: UserSettings = { plugins: { ...user.settings.plugins, ...(patch.plugins ?? {}) } }
    const updated = await updateUserSettings(this.db, DEFAULT_USER_ID, settings)
    this.broadcast({ type: 'settings.updated', settings: updated.settings })
    // Feature plugins toggled here would be loaded/disposed at this point; MVP ships none.
  }

  emitSessionCreated(s: Session): void {
    this.broadcast({ type: 'session.created', session: s })
    this.app.emit('session/created', s)
  }

  emitSessionUpdated(s: Session): void {
    this.broadcast({ type: 'session.updated', session: s })
    this.app.emit('session/updated', s)
  }

  // ---- inflight bookkeeping (used by generation.ts)

  inflight(): InflightJob[] {
    return [...this._inflight.values()]
  }

  /** Takes the job without its `settled` promise and assigns one in place (identity is preserved). */
  async trackInflight(job: Omit<InflightJob, 'settled'>): Promise<void> {
    const tracked = job as InflightJob
    tracked.settled = new Promise<void>((resolve) => { this._settlers.set(tracked.message.id, resolve) })
    this._inflight.set(tracked.message.id, tracked)
    await this.flushInflight(tracked)
    await this.ensureAlarm()
  }

  async flushInflight(job: InflightJob): Promise<void> {
    const stored: StoredInflight = { message: job.message, parts: job.parts, startedAt: job.startedAt }
    await this.state.storage.put(`${INFLIGHT_PREFIX}${job.message.id}`, stored)
  }

  async untrackInflight(messageId: number): Promise<void> {
    this._inflight.delete(messageId)
    await this.state.storage.delete(`${INFLIGHT_PREFIX}${messageId}`)
    if (this._inflight.size === 0) await this.state.storage.deleteAlarm()
    const settle = this._settlers.get(messageId)
    if (settle) {
      this._settlers.delete(messageId)
      settle()
    }
  }

  async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + GENERATION_TIMEOUT_MS)
    }
  }

  async onAlarm(): Promise<void> {
    const now = Date.now()
    let earliest = Infinity
    for (const job of this._inflight.values()) {
      if (now - job.startedAt >= GENERATION_TIMEOUT_MS) job.controller.abort('timeout')
      else earliest = Math.min(earliest, job.startedAt)
    }
    if (earliest !== Infinity) await this.state.storage.setAlarm(earliest + GENERATION_TIMEOUT_MS)
    // Everything left is already aborted but not yet untracked: keep watching instead of going dark.
    else if (this._inflight.size > 0) await this.state.storage.setAlarm(now + ALARM_WATCHDOG_MS)
  }

  /** A previous DO instance died mid-generation: persist what it had as aborted. */
  private async _recoverInflight(): Promise<void> {
    const stored = await this.state.storage.list<StoredInflight>({ prefix: INFLIGHT_PREFIX })
    for (const [key, job] of stored) {
      // Best-effort per entry: a failed finalize must not brick the DO on every wake, so the key
      // goes away either way.
      try {
        await finalizeMessage(this.db, job.message.id, { parts: job.parts, usage: null, status: 'aborted', error: 'interrupted' })
      } catch (err) {
        console.error('inflight recovery failed for message', job.message.id, err)
      }
      await this.state.storage.delete(key)
    }
    await this.state.storage.deleteAlarm()
  }
}

function safeRequestId(raw: string): string | undefined {
  try {
    const v = JSON.parse(raw) as { request_id?: unknown }
    return typeof v.request_id === 'string' ? v.request_id : undefined
  } catch {
    return undefined
  }
}

export const HubPlugin = {
  name: 'hub',
  async apply(ctx: Context) {
    await ctx.plugin(Hub)
  },
}

export { toMessage }
