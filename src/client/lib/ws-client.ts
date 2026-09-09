import { WsEventSchema, type WsCommand, type WsEvent } from '@/shared/ws'

export type WsStatus = 'connecting' | 'open' | 'closed'

export interface WsHandlers {
  onEvent(event: WsEvent): void
  onStatus(status: WsStatus): void
}

export interface WsOptions {
  socketFactory?: (url: string) => WebSocket
  minDelayMs?: number
  maxDelayMs?: number
  pingIntervalMs?: number
}

/** Single WebSocket with exponential-backoff reconnect and a send queue. No Vue dependency. */
export class WsClient {
  private _socket: WebSocket | null = null
  private _queue: string[] = []
  private _attempt = 0
  private _closedByUser = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _pingTimer: ReturnType<typeof setInterval> | null = null
  private readonly _factory: (url: string) => WebSocket
  private readonly _min: number
  private readonly _max: number
  private readonly _ping: number

  constructor(private readonly _url: string, private readonly _handlers: WsHandlers, opts: WsOptions = {}) {
    this._factory = opts.socketFactory ?? ((url) => new WebSocket(url))
    this._min = opts.minDelayMs ?? 1000
    this._max = opts.maxDelayMs ?? 30_000
    this._ping = opts.pingIntervalMs ?? 30_000
  }

  connect(): void {
    this._closedByUser = false
    this._attempt = 0
    this._open()
  }

  close(): void {
    this._closedByUser = true
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._stopPing()
    this._queue = []
    const socket = this._socket
    this._socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
  }

  send(cmd: WsCommand): void {
    const raw = JSON.stringify(cmd)
    if (this._socket && this._socket.readyState === 1) this._socket.send(raw)
    else this._queue.push(raw)
  }

  private _open(): void {
    this._handlers.onStatus('connecting')
    const ws = this._factory(this._resolveUrl())
    this._socket = ws
    ws.onopen = () => {
      this._attempt = 0
      this._handlers.onStatus('open')
      for (const raw of this._queue.splice(0)) ws.send(raw)
      this._startPing(ws)
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return
      let payload: unknown
      try {
        payload = JSON.parse(ev.data)
      } catch {
        console.warn('non-json ws frame', ev.data)
        return
      }
      const parsed = WsEventSchema.safeParse(payload)
      if (parsed.success) this._handlers.onEvent(parsed.data)
      else console.warn('unknown ws event', ev.data)
    }
    ws.onerror = () => { /* onclose follows */ }
    ws.onclose = () => {
      if (this._socket !== ws) return
      this._stopPing()
      this._socket = null
      this._handlers.onStatus('closed')
      if (!this._closedByUser) this._scheduleReconnect()
    }
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(this._max, this._min * 2 ** this._attempt)
    this._attempt++
    this._reconnectTimer = setTimeout(() => this._open(), delay)
  }

  private _startPing(ws: WebSocket): void {
    this._pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('ping') }, this._ping)
  }

  private _stopPing(): void {
    if (this._pingTimer) clearInterval(this._pingTimer)
    this._pingTimer = null
  }

  private _resolveUrl(): string {
    if (/^wss?:/.test(this._url)) return this._url
    if (typeof location === 'undefined') return this._url
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${this._url}`
  }
}
