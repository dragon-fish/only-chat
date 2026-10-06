import { Context, Service } from 'cordis'
import { ZodError } from 'zod'
import type { DB } from '../../db/client'
import { GENERATION_TIMEOUT_MS } from '@/shared/constants'
import type { Message, Project, Conversation, UserSettings } from '@/shared/models'
import type { Part } from '@/shared/parts'
import { encodeEvent, parseCommand, type WsCommand, type WsEvent } from '@/shared/ws'
import {
  assertUserAttachments, deleteConversation, finalizeMessage, firstUserMessageText, forkConversation, getMessage, getConversation,
  getModel, getProvider, getUser, renameIfTitleUnchanged, toMessage, updateConversation, updateUserSettings,
} from './conversations'
import { suggestConversationTitle } from './service-model'
import { canServeAsServiceModel, canServeAsFileModel } from '@/shared/service-model'
import { mergeServicePrompts, missingRequiredPlaceholders } from '@/shared/service-prompts'
import { cascadePluginSwitches, parseConversationPluginSettings, parseProjectPluginSettings } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'
import { createProject, deleteProject, getProject, listProjectConversations, updateProject, validateProjectIcon } from './projects'
import { SeqAllocator } from './seq'
import { joinStash } from '@/shared/stash'
import { logLifecycle, partsBytes } from './lifecycle-log'
import { deliverTaskNotifications, runEdit, runInterjectInterrupt, runRegenerate, runSend, runToolContinue, runToolRespond } from './generation'
import { TASK_STORAGE_PREFIX, type TaskSettlement } from './tasks'
import { ConversationOperations } from './operations'
import { Checkpoints } from './checkpoint-writer'
import { parseAuthUserId } from '../auth/user-id'
import { AUTH_REVOKED_CLOSE_CODE, hasActiveAuthSession, ORIGIN_STORAGE_KEY, type SocketAttachment } from './identity'

type GenerationEvent = Extract<WsEvent, { type: 'message.delta' | 'message.part' | 'message.done' | 'tool.progress' }>

export interface InflightJob {
  message: Message
  conversationId: number
  controller: AbortController
  startedAt: number
  parts: Part[]
  /** Resolves once the job untracked itself. Assigned by `trackInflight`; awaited by `stop`. */
  settled: Promise<void>
  /**
   * What the operator said while this turn was running, waiting for a boundary the model can be
   * told at. Held here rather than on the client because withdrawing races the injection, and a
   * client that decided for itself would sometimes take back something already sent.
   */
  stash: Part[]
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
  static readonly inject = ['env', 'doState', 'db', 'assets', 'llm', 'tools', 'promptSections', 'pluginChannel']

  /** Owning context (this.ctx inside methods is the caller's context, per cordis semantics). */
  readonly app: Context
  readonly state: DurableObjectState
  readonly db: DB
  readonly userId: number
  readonly seq = new SeqAllocator()
  /** Per-conversation operation lock (spec §1.4); notifications held back by it go out on release. */
  readonly operations = new ConversationOperations(conversationId => deliverTaskNotifications(this, conversationId))
  /** Writing checkpoints and collecting what plugins add to them (spec §1.4, §1.5). */
  readonly checkpoints = new Checkpoints(this)
  private readonly _inflight = new Map<number, InflightJob>()
  private readonly _settlers = new Map<number, () => void>()
  private _revoked = false
  private _accessEpoch = 0
  private _publicOrigin: string | null = null
  private _broadcastTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: { userId: number }) {
    super(ctx, 'hub')
    this.app = ctx
    this.state = ctx.doState
    this.db = ctx.db.orm
    this.userId = parseAuthUserId(config.userId)
  }

  async [Service.init]() {
    this._publicOrigin = await this.state.storage.get<string>(ORIGIN_STORAGE_KEY) ?? null
    await this._recoverInflight()
    // Notifications queued behind a turn that died with the previous instance: the alarm delivers them.
    if ((await this.state.storage.list({ prefix: TASK_STORAGE_PREFIX, limit: 1 })).size > 0) {
      await this.state.storage.setAlarm(Date.now())
    }
  }

  // ---- sockets

  /** A successful async session read must not outlive a concurrent revocation. */
  get accessEpoch(): number { return this._accessEpoch }

  /**
   * Where the browser reached this deployment, taken from the WebSocket upgrade. A tool that hands
   * out a link needs an absolute one, and the Durable Object has no request of its own to read an
   * origin off. Deliberately not an env var: a worktree runs on whatever port is free, and a pinned
   * value would point its links at production.
   *
   * Null only until the first connection of a brand-new hub. It must be read from storage rather
   * than kept in memory alone: a hibernated socket outlives this instance, and the command that
   * wakes it arrives with no request behind it.
   */
  get publicOrigin(): string | null {
    return this._publicOrigin
  }

  async rememberPublicOrigin(origin: string): Promise<void> {
    if (this._publicOrigin === origin) return
    this._publicOrigin = origin
    await this.state.storage.put(ORIGIN_STORAGE_KEY, origin)
  }

  async broadcast(event: WsEvent): Promise<void> {
    return this._enqueueBroadcast(event, true)
  }

  /** Deliver output already authorized by the command that started this generation. */
  async broadcastGeneration(event: GenerationEvent): Promise<void> {
    return this._enqueueBroadcast(event, false)
  }

  private async _enqueueBroadcast(event: WsEvent, validateSession: boolean): Promise<void> {
    const raw = encodeEvent(event)
    // Serialize whole broadcasts so all recipients observe the same order across producers.
    const sending = this._broadcastTail.then(() => this._deliverBroadcast(raw, validateSession))
    // Keep a rejected delivery visible to its caller without blocking subsequent broadcasts.
    this._broadcastTail = sending.catch(() => {})
    return sending
  }

  /** A plugin's own event to every device of this user; see `PluginChannel`. */
  broadcastPlugin(pluginId: string, payload: unknown): Promise<void> {
    return this.broadcast({ type: 'plugin.event', plugin: pluginId, payload })
  }

  private async _deliverBroadcast(raw: string, validateSession: boolean): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      try {
        const epoch = this._accessEpoch
        const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null
        // A generation is authorized once at its command/start boundary. Its output frames must not
        // turn D1 latency into model backpressure; explicit user revocation still stops them locally.
        if (this._revoked || (validateSession && (!(await hasActiveAuthSession(this.db, this.userId, attachment?.authSessionId)) || epoch !== this._accessEpoch))) {
          ws.close(AUTH_REVOKED_CLOSE_CODE, 'Authentication revoked')
          continue
        }
        ws.send(raw)
      } catch {
        // Database errors may contain credentials, and send failures need no client details either.
        console.warn('WebSocket delivery failed')
        try { ws.close(1011, 'Delivery unavailable') } catch { /* Socket already closed. */ }
      }
    }
  }

  handleConnect(ws: WebSocket): void {
    this._revoked = false
    ws.send(encodeEvent({
      type: 'snapshot',
      inflight: this.inflight().map((j) => ({ ...j.message, parts: j.parts })),
      compacting: this.operations.heldConversations(),
    }))
  }

  async handleCommand(ws: WebSocket, raw: string): Promise<void> {
    const epoch = this._accessEpoch
    const attachment = ws.deserializeAttachment() as Partial<SocketAttachment> | null
    if (this._revoked || !(await hasActiveAuthSession(this.db, this.userId, attachment?.authSessionId)) || epoch !== this._accessEpoch) {
      ws.close(AUTH_REVOKED_CLOSE_CODE, 'Authentication revoked')
      return
    }
    let cmd: WsCommand
    try {
      cmd = parseCommand(raw)
    } catch (err) {
      const requestId = safeRequestId(raw)
      await this.broadcast({
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
      await this.broadcast({ type: 'error', request_id: cmd.request_id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async _dispatch(cmd: WsCommand): Promise<void> {
    switch (cmd.type) {
      case 'send': return runSend(this, cmd)
      case 'regenerate': return runRegenerate(this, cmd)
      case 'edit': return runEdit(this, cmd)
      case 'stop':
        if (!(await getConversation(this.db, cmd.conversation_id, this.userId))) throw new Error('conversation not found')
        return this.stop(cmd.conversation_id)
      case 'switch_head': return this.switchHead(cmd.conversation_id, cmd.message_id)
      case 'conversation.update': return this.conversationUpdate(cmd)
      case 'conversation.delete': return this.conversationDelete(cmd.conversation_id)
      case 'conversation.suggest_title': return this.conversationSuggestTitle(cmd)
      case 'conversation.fork': return this.conversationFork(cmd)
      case 'settings.update': return this.settingsUpdate(cmd.settings)
      case 'project.create': return this.projectCreate(cmd)
      case 'project.update': return this.projectUpdate(cmd)
      case 'project.delete': return this.projectDelete(cmd.project_id)
      case 'tool.respond': return runToolRespond(this, cmd)
      case 'tool.continue': return runToolContinue(this, cmd)
      case 'interject': return this.interject(cmd.conversation_id, cmd.parts)
      case 'interject.withdraw': return this.withdrawInterjection(cmd.conversation_id)
      case 'interject.interrupt': return runInterjectInterrupt(this, cmd)
      case 'plugin.command': return this.app.pluginChannel.dispatch(cmd.plugin, cmd.payload, this)
    }
  }

  // ---- non-generation commands

  /**
   * Aborts the conversation's generations, and any operation holding it, and waits for them to
   * unwind, so a caller like `conversationDelete` can touch the rows right afterwards.
   * `generation.ts` must always call `untrackInflight()` from its finally path, and an operation
   * must release its lock; otherwise they only settle through the timeout below.
   */
  async stop(conversationId: number): Promise<void> {
    const settled: Promise<void>[] = []
    for (const job of this._inflight.values()) {
      if (job.conversationId !== conversationId) continue
      job.controller.abort('user stopped')
      settled.push(job.settled)
    }
    const operation = this.operations.abort(conversationId, 'user stopped')
    if (operation) settled.push(operation)
    await this._awaitSettlement(settled)
  }

  async revokeAccess(): Promise<void> {
    this._revoked = true
    this._accessEpoch++
    const settled: Promise<void>[] = []
    for (const job of this._inflight.values()) {
      job.controller.abort('authentication revoked')
      settled.push(job.settled)
    }
    try { await this._awaitSettlement(settled) }
    finally {
      for (const ws of this.state.getWebSockets()) ws.close(AUTH_REVOKED_CLOSE_CODE, 'Authentication revoked')
    }
  }

  private async _awaitSettlement(settled: Promise<void>[]): Promise<void> {
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

  async switchHead(conversationId: number, messageId: number): Promise<void> {
    this.operations.assertFree(conversationId)
    const m = await getMessage(this.db, messageId, this.userId)
    if (!m || m.conversation_id !== conversationId) throw new Error('message not in conversation')
    const s = await updateConversation(this.db, conversationId, this.userId, { head_message_id: messageId })
    await this.broadcast({ type: 'head.changed', conversation_id: conversationId, message_id: messageId })
    await this.emitConversationUpdated(s)
  }

  async conversationUpdate(cmd: Extract<WsCommand, { type: 'conversation.update' }>): Promise<void> {
    const { type: _t, request_id: _r, conversation_id, tools, plugin_settings, ...patch } = cmd
    const current = await getConversation(this.db, conversation_id, this.userId)
    if (!current) throw new Error('conversation not found')
    // Moving a conversation into a Project must never cross into another user's Project (spec §5.1).
    if (patch.project_id != null && !(await getProject(this.db, patch.project_id, this.userId))) {
      throw new Error('project not found')
    }
    const s = await updateConversation(this.db, conversation_id, this.userId, {
      ...patch,
      ...(tools === undefined ? {} : { tools: this.app.tools.normalize(tools) }),
      ...(plugin_settings === undefined
        ? {}
        : { plugin_settings: { ...current.plugin_settings, ...parseConversationPluginSettings(pluginManifests, plugin_settings) } }),
    })
    await this.emitConversationUpdated(s)
  }

  async conversationDelete(conversationId: number): Promise<void> {
    if (!(await getConversation(this.db, conversationId, this.userId))) throw new Error('conversation not found')
    this.operations.assertFree(conversationId)
    await this.stop(conversationId)
    await this.app.parallel('conversation/before-purge', { userId: this.userId, conversationId })
    await deleteConversation(this.db, conversationId, this.userId)
    this.seq.forget(conversationId)
    await this.broadcast({ type: 'conversation.deleted', conversation_id: conversationId })
    this.app.emit('conversation/deleted', conversationId)
  }

  /**
   * Names a conversation with the service model and replaces the placeholder it was given.
   *
   * Never awaited by the turn that triggers it: a conversation is usable the moment it exists, and
   * its name arriving a few seconds later costs nothing. Silent throughout — see
   * `suggestConversationTitle` for why none of its failures are worth reporting.
   */
  async nameConversation(conversationId: number, placeholder: string, firstText: string): Promise<void> {
    const user = await getUser(this.db, this.userId)
    if (!user) return
    const title = await suggestConversationTitle({ db: this.db, llm: this.app.llm }, this.userId, user.settings, firstText)
    if (title === null || title === placeholder) return
    const renamed = await renameIfTitleUnchanged(this.db, conversationId, this.userId, placeholder, title)
    if (renamed) await this.emitConversationUpdated(renamed)
  }

  /** The same suggestion on request, handed back for the user to accept rather than applied. */
  async conversationSuggestTitle(cmd: Extract<WsCommand, { type: 'conversation.suggest_title' }>): Promise<void> {
    const user = await getUser(this.db, this.userId)
    if (!user) throw new Error('user missing')
    if (!(await getConversation(this.db, cmd.conversation_id, this.userId))) throw new Error('conversation not found')
    const text = await firstUserMessageText(this.db, cmd.conversation_id, this.userId)
    const title = await suggestConversationTitle({ db: this.db, llm: this.app.llm }, this.userId, user.settings, text)
    await this.broadcast({
      type: 'conversation.title_suggested', request_id: cmd.request_id,
      conversation_id: cmd.conversation_id, title,
    })
  }

  async conversationFork(cmd: Extract<WsCommand, { type: 'conversation.fork' }>): Promise<void> {
    if (this._inflight.has(cmd.message_id)) throw new Error('cannot fork a streaming message')
    // `parallel` awaits every listener and rethrows their failures, which is what lets a plugin
    // that cannot carry its own rows over abort the fork instead of leaving one half-copied.
    const conversation = await forkConversation(this.db, cmd.conversation_id, this.userId, cmd.message_id,
      payload => this.app.parallel('conversation/forked', payload))
    await this.emitConversationCreated(conversation)
    await this.broadcast({ type: 'conversation.forked', request_id: cmd.request_id, conversation_id: conversation.id })
  }

  /** Derived from the command rather than restated: a new setting must not compile until handled. */
  async settingsUpdate(patch: Extract<WsCommand, { type: 'settings.update' }>['settings']): Promise<void> {
    const user = await getUser(this.db, this.userId)
    if (!user) throw new Error('user missing')
    // Refused here as well as hidden from the picker: settings arrive over a socket, and the only
    // authority on what a model can do is this side of it.
    const image = patch.service_models?.image
    if (image && !(await getModel(this.db, image.provider_id, image.model_id, this.userId))?.supports_image_output) {
      throw new Error('image model not found')
    }
    const text = patch.service_models?.text
    if (text) {
      const provider = await getProvider(this.db, text.provider_id, this.userId)
      const model = await getModel(this.db, text.provider_id, text.model_id, this.userId)
      if (!provider?.enabled || !model?.enabled || !canServeAsServiceModel(model.metadata_resolved)) {
        throw new Error('service model not found')
      }
    }
    const fileModel = patch.service_models?.file_understanding
    if (fileModel) {
      const provider = await getProvider(this.db, fileModel.provider_id, this.userId)
      const model = await getModel(this.db, fileModel.provider_id, fileModel.model_id, this.userId)
      if (!provider?.enabled || !model?.enabled || !canServeAsFileModel(model.metadata_resolved)) throw new Error('file understanding model not found')
    }
    const titlePrompt = patch.service_prompts?.conversation_title
    if (typeof titlePrompt === 'string') {
      const missing = missingRequiredPlaceholders(titlePrompt)
      if (missing.length > 0) throw new Error(`title prompt must contain ${missing.join(', ')}`)
    }
    const settings: UserSettings = {
      ...user.settings,
      plugins: { ...user.settings.plugins, ...cascadePluginSwitches(pluginManifests, patch.plugins ?? {}) },
      ...(patch.service_models === undefined
        ? {}
        : { service_models: { ...user.settings.service_models, ...patch.service_models } }),
      ...(patch.service_prompts === undefined
        ? {}
        : { service_prompts: mergeServicePrompts(user.settings.service_prompts, patch.service_prompts) }),
    }
    const updated = await updateUserSettings(this.db, this.userId, settings)
    await this.broadcast({ type: 'settings.updated', settings: updated.settings })
    // Built-in server registrations stay loaded; request-time resolution applies this enable map.
  }

  async projectCreate(cmd: Extract<WsCommand, { type: 'project.create' }>): Promise<void> {
    const { type: _t, request_id: _r, ...input } = cmd
    await validateProjectIcon(this.db, this.userId, input.icon_attachment_id ?? null)
    const p = await createProject(this.db, { user_id: this.userId, ...input })
    await this.emitProjectCreated(p)
  }

  async projectUpdate(cmd: Extract<WsCommand, { type: 'project.update' }>): Promise<void> {
    const { type: _t, request_id: _r, project_id, plugin_settings, ...patch } = cmd
    const current = await getProject(this.db, project_id, this.userId)
    if (!current) throw new Error('project not found')
    await validateProjectIcon(this.db, this.userId, patch.icon_attachment_id === undefined ? current.icon_attachment_id : patch.icon_attachment_id)
    const p = await updateProject(this.db, project_id, this.userId, plugin_settings === undefined ? patch : {
      ...patch,
      // Per plugin, like conversation settings: one plugin saving its tab leaves the others' alone.
      plugin_settings: { ...current.plugin_settings, ...parseProjectPluginSettings(pluginManifests, plugin_settings) },
    })
    await this.emitProjectUpdated(p)
  }

  /**
   * Fetches affected conversations before deleting (spec §5.1): the FK nulls their `project_id` in the
   * same delete statement, so the pre-delete read is the only way to know which conversations moved.
   */
  async projectDelete(projectId: number): Promise<void> {
    const affected = await listProjectConversations(this.db, projectId, this.userId)
    const deleted = await deleteProject(this.db, projectId, this.userId)
    await this.emitProjectDeleted(deleted.id)
    for (const row of affected) await this.emitConversationUpdated({ ...row, project_id: null })
  }

  async emitConversationCreated(s: Conversation): Promise<void> {
    await this.broadcast({ type: 'conversation.created', conversation: s })
    this.app.emit('conversation/created', s)
  }

  async emitConversationUpdated(s: Conversation): Promise<void> {
    await this.broadcast({ type: 'conversation.updated', conversation: s })
    this.app.emit('conversation/updated', s)
  }

  async emitProjectCreated(p: Project): Promise<void> {
    await this.broadcast({ type: 'project.created', project: p })
    this.app.emit('project/created', p)
  }

  async emitProjectUpdated(p: Project): Promise<void> {
    await this.broadcast({ type: 'project.updated', project: p })
    this.app.emit('project/updated', p)
  }

  async emitProjectDeleted(projectId: number): Promise<void> {
    await this.broadcast({ type: 'project.deleted', project_id: projectId })
    this.app.emit('project/deleted', projectId)
  }

  // ---- inflight bookkeeping (used by generation.ts)

  inflight(): InflightJob[] {
    return [...this._inflight.values()]
  }

  /** Takes the job without its `settled` promise and assigns one in place (identity is preserved). */
  async trackInflight(job: Omit<InflightJob, 'settled'>): Promise<void> {
    if (this._revoked) throw new Error('Authentication revoked')
    const tracked = job as InflightJob
    tracked.settled = new Promise<void>((resolve) => { this._settlers.set(tracked.message.id, resolve) })
    this._inflight.set(tracked.message.id, tracked)
    await this.flushInflight(tracked)
    await this.ensureAlarm()
  }

  /** The job this conversation is running, if any. One generation per conversation at a time. */
  private jobFor(conversationId: number): InflightJob | undefined {
    return [...this._inflight.values()].find(job => job.conversationId === conversationId)
  }

  /**
   * Add to the stash. Repeated sends join rather than queue: a turn reads one message, and three
   * arriving as three would be three interruptions of the same thought.
   */
  async interject(conversationId: number, parts: Part[]): Promise<void> {
    // Validated before looking the job up: an await between the two could outlive the job.
    await assertUserAttachments(this.db, this.userId, parts)
    const job = this.jobFor(conversationId)
    if (!job) throw new Error('nothing is generating in this conversation')
    job.stash = joinStash(job.stash, parts)
    logLifecycle('interject.queued', {
      conversationId, messageId: job.message.id, userId: this.userId,
      bytes: partsBytes(parts), count: job.stash.length,
    })
    await this.broadcast({ type: 'interject.stash', conversation_id: conversationId, parts: job.stash })
  }

  /** Take the stash back, or report it empty because the model has already been told. */
  async withdrawInterjection(conversationId: number): Promise<void> {
    const job = this.jobFor(conversationId)
    const parts = job?.stash ?? []
    if (job) job.stash = []
    logLifecycle('interject.withdrawn', {
      conversationId, userId: this.userId, bytes: partsBytes(parts),
      reason: parts.length === 0 ? 'already_delivered' : 'returned',
    })
    await this.broadcast({ type: 'interject.withdrawn', conversation_id: conversationId, parts })
    await this.broadcast({ type: 'interject.stash', conversation_id: conversationId, parts: [] })
  }

  /** Empty the stash and return what was in it. The drain and a withdrawal cannot both win. */
  takeStash(messageId: number): Part[] {
    const job = this._inflight.get(messageId)
    if (!job || job.stash.length === 0) return []
    const parts = job.stash
    job.stash = []
    return parts
  }

  /** Durable, unlike the stash: a settled task must survive the DO restarting before it is delivered. */
  async queueTask(settlement: TaskSettlement): Promise<void> {
    await this.state.storage.put(TASK_STORAGE_PREFIX + settlement.notification.task_id, settlement)
  }

  async queuedTasks(conversationId: number): Promise<TaskSettlement[]> {
    const stored = await this.state.storage.list<TaskSettlement>({ prefix: TASK_STORAGE_PREFIX })
    return [...stored.values()].filter(entry => entry.conversation_id === conversationId)
  }

  async dropTask(taskId: string): Promise<void> {
    await this.state.storage.delete(TASK_STORAGE_PREFIX + taskId)
  }

  /**
   * Queue first, then deliver unless a turn is running: that turn takes it between steps, or
   * delivers it when it ends. Awaits any turn it starts — the caller's request is what keeps the DO
   * alive, the same way `webSocketMessage` awaits a send.
   */
  async settleTask(settlement: TaskSettlement): Promise<void> {
    await this.queueTask(settlement)
    if (this.inflight().some(job => job.conversationId === settlement.conversation_id)) return
    await deliverTaskNotifications(this, settlement.conversation_id)
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
    else {
      const queued = await this.state.storage.list<TaskSettlement>({ prefix: TASK_STORAGE_PREFIX })
      for (const conversationId of new Set([...queued.values()].map(entry => entry.conversation_id))) {
        await deliverTaskNotifications(this, conversationId).catch(error => console.error('task delivery failed', error))
      }
    }
  }

  /** A previous DO instance died mid-generation: persist what it had as aborted. */
  private async _recoverInflight(): Promise<void> {
    const stored = await this.state.storage.list<StoredInflight>({ prefix: INFLIGHT_PREFIX })
    for (const [key, job] of stored) {
      // Best-effort per entry: a failed finalize must not brick the DO on every wake, so the key
      // goes away either way.
      try {
        await finalizeMessage(this.db, job.message.id, this.userId, { parts: job.parts, usage: null, status: 'aborted', error: 'interrupted' })
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
  async apply(ctx: Context, config: { userId: number }) {
    await ctx.plugin(Hub, config)
  },
}

export { toMessage }
