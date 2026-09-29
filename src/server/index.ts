import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { createApp } from './app'
import { createDb } from './db/client'
import { cleanupExpiredProviderFiles } from './plugins/files-cleanup'
import { sweepTrash } from '@/server/plugins/workspace-files/service'
import { refreshCatalog } from './plugins/model-catalog/refresh'
import { CatalogStorage } from './plugins/model-catalog/storage'
import { disposeRpcStub } from './rpc'
import { parseAuthUserId } from './plugins/auth/user-id'
import { AUTH_REVOKED_PATH, hasActiveAuthSession, INTERNAL_AUTH_SESSION_ID_HEADER, INTERNAL_USER_ID_HEADER, USER_ID_STORAGE_KEY, type SocketAttachment } from './plugins/hub/identity'
import { executeImageRun } from './plugins/artifacts/workflow'
import { notifyToolRun } from './plugins/artifacts/notify'
import type { Conversation } from '@/shared/models'
import type { TaskSettlement } from './plugins/hub/tasks'
export { BrowserGateway, BrowserHost, BrowserRunner } from '@/plugins/cloudflare-browser-run/server/entrypoints'

let workerApp: Promise<Context> | undefined

async function startScheduledCatalogRefresh(env: Env, scheduledTime: number): Promise<void> {
  const instance = await env.MODEL_CATALOG_REFRESH.create({
    id: `catalog-cron-${scheduledTime}`,
    params: { source: 'cron' },
  })
  disposeRpcStub(instance)
}

export default {
  async fetch(request, env, execCtx) {
    workerApp ??= createApp({ env, side: 'worker' })
    const ctx = await workerApp
    return ctx.api.fetch(request, env, execCtx)
  },
  // Catalog publication and remote file cleanup must run independently.
  async scheduled(controller, env, _execCtx) {
    workerApp ??= createApp({ env, side: 'worker' })
    const ctx = await workerApp
    await Promise.all([
      startScheduledCatalogRefresh(env, controller.scheduledTime).catch(error => console.error('Could not start scheduled catalog refresh', error)),
      cleanupExpiredProviderFiles(ctx, Date.now()).catch(() => console.error('Scheduled provider file cleanup failed')),
      sweepTrash(ctx.db.orm, ctx.assets, Date.now())
        .then(({ files, bytes }) => { if (files > 0) console.log('Swept trashed workspace files', { files, bytes }) })
        .catch(error => console.error('Scheduled workspace trash sweep failed', error)),
    ])
  },
} satisfies ExportedHandler<Env>

export class ModelCatalogRefreshWorkflow extends WorkflowEntrypoint<Env, { source: 'manual' | 'cron' }> {
  async run(_event: Readonly<WorkflowEvent<{ source: 'manual' | 'cron' }>>, step: WorkflowStep) {
    return step.do('refresh model catalog', {
      retries: { limit: 8, delay: '10 seconds', backoff: 'exponential' },
      timeout: '10 minutes',
    }, async () => refreshCatalog(new CatalogStorage(this.env.KV), createDb(this.env.DB)))
  }
}

export class ArtifactGenerationWorkflow extends WorkflowEntrypoint<Env, { userId: number; runId: number }> {
  async run(event: Readonly<WorkflowEvent<{ userId: number; runId: number }>>, step: WorkflowStep) {
    await step.do('generate image artifact', {
      retries: { limit: 0, delay: '1 second' },
      timeout: '30 minutes',
    }, async () => executeImageRun(await createApp({ env: this.env, side: 'workflow' }), event.payload.userId, event.payload.runId))
    // Delivery may start the Agent's next turn and waits for it, hence the long timeout. Retrying is
    // safe: the hub delivers each task id once.
    await step.do('notify agent', {
      retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
      timeout: '15 minutes',
    }, async () => notifyToolRun(await createApp({ env: this.env, side: 'workflow' }), event.payload.userId, event.payload.runId))
  }
}

export class UserHub extends DurableObject<Env> {
  private _app?: Context
  private _userId?: number

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered by the runtime without waking the DO, so client keepalives never reach handleCommand.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(async () => {
      const owner = await ctx.storage.get<number>(USER_ID_STORAGE_KEY)
      if (owner !== undefined) {
        this._userId = parseAuthUserId(owner)
        this._app = await createApp({ env, side: 'hub', doState: ctx, userId: this._userId })
      }
    })
  }

  /** Exposed for tests (runInDurableObject). */
  get app(): Context {
    if (!this._app) throw new Error('UserHub identity is not initialized')
    return this._app
  }

  private async ensureOwner(userId: number): Promise<boolean> {
    const parsed = parseAuthUserId(userId)
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this._userId !== undefined) return this._userId === parsed
      await this.ctx.storage.put(USER_ID_STORAGE_KEY, parsed)
      this._userId = parsed
      this._app = await createApp({ env: this.env, side: 'hub', doState: this.ctx, userId: parsed })
      return true
    })
  }

  /**
   * A plugin's trusted Worker-side code (an exported entrypoint) reaching its Durable Object half.
   * Identity is asserted by the caller, which is why only code shipped with this Worker may call it.
   */
  async pluginHostCall(userId: number, pluginId: string, payload: unknown): Promise<unknown> {
    const parsed = parseAuthUserId(userId)
    if (!(await this.ensureOwner(parsed))) throw new Error('Hub identity mismatch')
    return this.app.pluginChannel.dispatchHostCall(pluginId, payload, this.app.hub)
  }

  /** Lets authenticated HTTP/Workflow producers reuse the same realtime stream as chat commands. */
  async publishConversation(userId: number, conversation: Conversation, created: boolean): Promise<void> {
    const parsed = parseAuthUserId(userId)
    if (conversation.user_id !== parsed || !(await this.ensureOwner(parsed))) throw new Error('Hub identity mismatch')
    if (created) await this.app.hub.emitConversationCreated(conversation)
    else await this.app.hub.emitConversationUpdated(conversation)
  }

  /** A background task started in one of this user's conversations has finished. */
  async settleTask(userId: number, settlement: TaskSettlement): Promise<void> {
    if (!(await this.ensureOwner(parseAuthUserId(userId)))) throw new Error('Hub identity mismatch')
    await this.app.hub.settleTask(settlement)
  }

  async fetch(request: Request): Promise<Response> {
    let userId: number
    try { userId = parseAuthUserId(request.headers.get(INTERNAL_USER_ID_HEADER) ?? '') }
    catch { return new Response('Invalid hub identity', { status: 403 }) }
    const revoke = new URL(request.url).pathname === AUTH_REVOKED_PATH && request.method === 'POST'
    const authSessionId = request.headers.get(INTERNAL_AUTH_SESSION_ID_HEADER)
    if (!revoke && !authSessionId) return new Response('Missing AuthSession', { status: 403 })
    // Two first fetches must never initialize different identities across an await.
    const owned = await this.ensureOwner(userId)
    if (!owned) return new Response('Hub identity mismatch', { status: 403 })
    if (revoke) {
      await this.app.hub.revokeAccess()
      return new Response(null, { status: 204 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 })
    const epoch = this.app.hub.accessEpoch
    if (!(await hasActiveAuthSession(this.app.db.orm, userId, authSessionId)) || epoch !== this.app.hub.accessEpoch) {
      return new Response('Unauthorized', { status: 401 })
    }
    // The Worker forwards the browser's own request, so its URL is the public one. Recorded per
    // connection rather than configured, which is what lets a worktree serve links on its own port.
    await this.app.hub.rememberPublicOrigin(new URL(request.url).origin)
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.serializeAttachment({ authSessionId: authSessionId! } satisfies SocketAttachment)
    this.ctx.acceptWebSocket(server)
    this.app.hub.handleConnect(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    // Awaited on purpose: the generation must stay inside this event to keep the DO alive.
    await this.app.hub.handleCommand(ws, message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // workerd rejects the reserved codes (1005 "no status", 1006 "abnormal") on close().
    if (code >= 1000 && code !== 1005 && code !== 1006) ws.close(code, reason)
    else ws.close()
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('websocket error', error)
  }

  async alarm(): Promise<void> {
    await this._app?.hub.onAlarm()
  }
}
