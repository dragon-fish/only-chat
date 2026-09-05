import { exports } from 'cloudflare:workers'
import type { WsEvent } from '@/shared/ws'

export interface WsHarness {
  ws: WebSocket
  events: WsEvent[]
  /** Resolves with the first event of that type already received or the next one to arrive. */
  next: (type: WsEvent['type']) => Promise<WsEvent>
}

export async function connect(): Promise<WsHarness> {
  const res = await exports.default.fetch(new Request('https://x/ws', { headers: { Upgrade: 'websocket' } }))
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`)
  const ws = res.webSocket
  ws.accept()
  const events: WsEvent[] = []
  const waiters: Array<{ type: string; resolve: (e: WsEvent) => void }> = []
  ws.addEventListener('message', (ev) => {
    const e = JSON.parse(ev.data as string) as WsEvent
    events.push(e)
    for (const w of [...waiters]) if (w.type === e.type) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e) }
  })
  const next = (type: WsEvent['type']) => new Promise<WsEvent>((resolve, reject) => {
    const found = events.find((e) => e.type === type)
    if (found) return resolve(found)
    waiters.push({ type, resolve })
    setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000)
  })
  return { ws, events, next }
}
