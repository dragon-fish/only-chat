import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'
import type { Context } from 'cordis'
import { createApp } from './app'
import { DEFAULT_USER_ID } from '@/shared/constants'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/ws', (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426)
  const stub = c.env.USER_HUB.getByName(String(DEFAULT_USER_ID))
  return stub.fetch(c.req.raw)
})

export default { fetch: app.fetch } satisfies ExportedHandler<Env>

export class UserHub extends DurableObject<Env> {
  private _app!: Context

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this._app = await createApp({ env, side: 'hub', doState: ctx })
    })
  }

  /** Exposed for tests (runInDurableObject). */
  get app(): Context {
    return this._app
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
    ws.close(code, reason)
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error('websocket error', error)
  }

  async alarm(): Promise<void> {
    await this._app.hub.onAlarm()
  }
}
