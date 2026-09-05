import { Hono } from 'hono'
import { DurableObject } from 'cloudflare:workers'

const app = new Hono<{ Bindings: Env }>()
app.get('/api/health', (c) => c.json({ ok: true }))

export default { fetch: app.fetch } satisfies ExportedHandler<Env>

export class UserHub extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 })
  }
}
