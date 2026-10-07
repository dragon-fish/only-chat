import { WsCommandSchema, encodeEvent, type WsCommand, type WsEvent } from '@/shared/ws'

export interface SocketPeer {
  /** Called for every command the app sends. */
  receive: (command: WsCommand) => void
  /** Called once per socket, with the function that delivers server events to it. */
  attach: (emit: (event: WsEvent) => void) => void
}

/**
 * Enough of `WebSocket` for `WsClient`: it assigns the `on*` handlers as properties, sends plain
 * strings, and pings with the literal `'ping'`. Only `/ws` is accepted; anything else throws, so a
 * socket the demo did not plan for can never reach a real server.
 */
export function createFakeWebSocket(peer: SocketPeer, origin: string): typeof WebSocket {
  const expected = new URL('/ws', origin)

  class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3

    readonly url: string
    readyState = 0
    binaryType: BinaryType = 'blob'
    bufferedAmount = 0
    extensions = ''
    protocol = ''
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null

    constructor(url: string | URL) {
      super()
      const target = new URL(url, origin)
      if (target.host !== expected.host || target.pathname !== '/ws') throw new Error(`[demo] refused socket to ${target.href}`)
      this.url = target.href
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.onopen?.(new Event('open'))
        peer.attach(event => {
          if (this.readyState === 1) this.onmessage?.(new MessageEvent('message', { data: encodeEvent(event) }))
        })
      })
    }

    send(data: string): void {
      if (this.readyState !== 1 || data === 'ping') return
      const parsed = WsCommandSchema.safeParse(JSON.parse(data))
      if (!parsed.success) {
        console.error('[demo] unparseable command', data)
        return
      }
      peer.receive(parsed.data)
    }

    close(): void {
      if (this.readyState >= 2) return
      this.readyState = 3
      this.onclose?.(new CloseEvent('close', { code: 1000 }))
    }
  }

  return FakeWebSocket as unknown as typeof WebSocket
}
