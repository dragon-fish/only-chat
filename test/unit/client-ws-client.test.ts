import { describe, expect, it, vi } from 'vitest'
import { WsClient } from '@/client/lib/ws-client'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { FakeSocket.instances.push(this) }
  send(d: string) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
}

describe('WsClient', () => {
  it('connects, forwards events, queues sends until open, reconnects with backoff', async () => {
    vi.useFakeTimers()
    FakeSocket.instances = []
    const events: unknown[] = []
    const statuses: string[] = []
    const client = new WsClient('/ws', { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) }, {
      socketFactory: (url) => new FakeSocket(url) as unknown as WebSocket, minDelayMs: 100, maxDelayMs: 400,
    })
    client.connect()
    client.send({ type: 'stop', session_id: 1 })
    const s1 = FakeSocket.instances[0]!
    expect(s1.sent).toEqual([])
    s1.open()
    expect(s1.sent).toEqual([JSON.stringify({ type: 'stop', session_id: 1 })])
    s1.onmessage?.({ data: JSON.stringify({ type: 'session.deleted', session_id: 3 }) })
    expect(events).toEqual([{ type: 'session.deleted', session_id: 3 }])

    s1.close()
    expect(statuses.at(-1)).toBe('closed')
    vi.advanceTimersByTime(100)
    expect(FakeSocket.instances).toHaveLength(2)
    FakeSocket.instances[1]!.close()
    vi.advanceTimersByTime(199)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
    client.close()
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.useRealTimers()
  })
})
