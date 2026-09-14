/**
 * The Browser Run binding's control endpoints, called directly. `@cloudflare/playwright` wraps the
 * same three requests, but importing it pulls the whole library into the Durable Object bundle;
 * these are three fetches.
 */
const FAKE_HOST = 'http://fake.host'

/** The Browser Run binding, reduced to the one method these calls need. */
export type BrowserBinding = { fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> }

export interface ActiveSession {
  sessionId: string
  startTime?: string
  /** Set while some Worker is connected to it. */
  connectionId?: string
}

export class BrowserRateLimited extends Error {
  constructor(readonly retryAfterSeconds: number | null, detail: string) {
    super(detail)
    this.name = 'BrowserRateLimited'
  }
}

async function call(binding: BrowserBinding, path: string): Promise<string> {
  const response = await binding.fetch(`${FAKE_HOST}${path}`)
  const text = await response.text()
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new BrowserRateLimited(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null, text)
  }
  // Only the first line: a failure body can carry a stack trace, and that would reach the model.
  if (!response.ok) throw new Error(`Browser Run ${path} failed: ${response.status} ${text.split('\n')[0]?.trim() ?? ''}`)
  return text
}

export async function acquireSession(binding: BrowserBinding, keepAliveMs: number): Promise<{ sessionId: string }> {
  const params = new URLSearchParams({ keep_alive: String(keepAliveMs) })
  const body = JSON.parse(await call(binding, `/v1/acquire?${params}`)) as { sessionId?: unknown }
  if (typeof body.sessionId !== 'string') throw new Error('Browser Run acquire returned no session id')
  return { sessionId: body.sessionId }
}

export async function listSessions(binding: BrowserBinding): Promise<ActiveSession[]> {
  const body = JSON.parse(await call(binding, '/v1/sessions')) as { sessions?: unknown }
  return Array.isArray(body.sessions) ? body.sessions as ActiveSession[] : []
}
