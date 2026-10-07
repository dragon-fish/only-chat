export interface FakeRequest {
  method: string
  path: string
  query: URLSearchParams
  match: RegExpMatchArray
}

export interface FakeRoute {
  method: string
  /** Matched against the pathname only; write it anchored (`^…$`). */
  path: RegExp
  /** A value is sent as JSON; `undefined` as an empty 204. */
  handle: (request: FakeRequest) => unknown
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: body === undefined && status === 200 ? 204 : status,
    headers: { 'content-type': 'application/json' },
  })
}

function requestUrl(input: RequestInfo | URL, origin: string): URL {
  if (input instanceof URL) return input
  if (typeof input === 'string') return new URL(input, origin)
  return new URL(input.url, origin)
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
}

/**
 * Answers every same-origin `/api/*` request from `routes`.
 *
 * Fails closed: an unmatched API request gets a 501 and never reaches the network. The demo shares
 * an origin with the real app, so a request let through would carry whatever session cookie this
 * browser holds and read real data.
 */
export function createFakeFetch(routes: FakeRoute[], realFetch: typeof fetch, origin: string): typeof fetch {
  return async (input, init) => {
    const url = requestUrl(input, origin)
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return realFetch(input, init)
    const method = requestMethod(input, init)
    for (const route of routes) {
      if (route.method !== method) continue
      const match = url.pathname.match(route.path)
      if (!match) continue
      return json(200, route.handle({ method, path: url.pathname, query: url.searchParams, match }))
    }
    console.error(`[demo] no scripted response for ${method} ${url.pathname}`)
    return json(501, { error: '演示模式不支持该操作' })
  }
}
