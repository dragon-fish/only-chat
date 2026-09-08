import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { createApp } from './app'
import { createDb } from './db/client'
import { cleanupExpiredProviderFiles } from './plugins/files-cleanup'
import { refreshCatalog } from './plugins/model-catalog/refresh'
import { CatalogStorage } from './plugins/model-catalog/storage'
import { disposeRpcStub } from './rpc'

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

export class UserHub extends DurableObject<Env> {
  private _app!: Context

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered by the runtime without waking the DO, so client keepalives never reach handleCommand.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    ctx.blockConcurrencyWhile(async () => {
      this._app = await createApp({ env, side: 'hub', doState: ctx })
    })
  }

  /** Exposed for tests (runInDurableObject). */
  get app(): Context {
    return this._app
  }

  async startCodexOAuth(providerId?: number) {
    return this._app.codex.start(providerId)
  }

  async pollCodexOAuth(flowId: string) {
    return this._app.codex.poll(flowId)
  }

  async cancelCodexOAuth(flowId: string) {
    return this._app.codex.cancel(flowId)
  }

  async listCodexModels(providerId: number): Promise<string[]> {
    return this._app.codex.listModels(providerId)
  }

  async disconnectCodexProvider(providerId: number) {
    return this._app.codex.disconnect(providerId)
  }

  async prepareCodexDelete(providerId: number) {
    return this._app.codex.disconnect(providerId)
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    this._app.hub.handleConnect(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    // Awaited on purpose: the generation must stay inside this event to keep the DO alive.
    await this._app.hub.handleCommand(message)
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
    await this._app.hub.onAlarm()
  }
}
