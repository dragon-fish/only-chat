import { authenticatedFetch } from './auth-helper'
import type { WsEvent } from '@/shared/ws'

export interface WsHarness {
  ws: WebSocket
  events: WsEvent[]
  /** Frames that are not JSON events, e.g. the `pong` auto-response. */
  raw: string[]
  /** Resolves with the first event of that type already received or the next one to arrive. */
  next: (type: WsEvent['type']) => Promise<WsEvent>
  /** Resolves with the `count`-th (1-based) event of that type, waiting for it if needed. */
  nextAfter: (type: WsEvent['type'], count: number) => Promise<WsEvent>
}

interface Waiter {
  type: string
  count: number
  resolve: (e: WsEvent) => void
}

export async function connect(): Promise<WsHarness> {
  const res = await authenticatedFetch(new Request('https://x/ws', { headers: { Upgrade: 'websocket' } }))
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`)
  const ws = res.webSocket
  ws.accept()
  const events: WsEvent[] = []
  const raw: string[] = []
  const waiters: Waiter[] = []
  ws.addEventListener('message', (ev) => {
    const data = ev.data as string
    let e: WsEvent
    try {
      e = JSON.parse(data) as WsEvent
    } catch {
      raw.push(data)
      return
    }
    events.push(e)
    for (const w of [...waiters]) {
      if (w.type !== e.type) continue
      const seen = events.filter((x) => x.type === w.type)
      if (seen.length < w.count) continue
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(seen[w.count - 1]!)
    }
  })
  const nextAfter = (type: WsEvent['type'], count: number) => new Promise<WsEvent>((resolve, reject) => {
    const seen = events.filter((e) => e.type === type)
    if (seen.length >= count) return resolve(seen[count - 1]!)
    waiters.push({ type, count, resolve })
    setTimeout(() => reject(new Error(`timeout waiting for ${type} #${count}`)), 5000)
  })
  return { ws, events, raw, next: (type) => nextAfter(type, 1), nextAfter }
}
