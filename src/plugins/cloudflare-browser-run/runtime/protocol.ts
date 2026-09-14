/**
 * The contract between the three places browser code passes through: the Durable Object that owns
 * the conversation, the `BrowserRunner` entrypoint that loads the Dynamic Worker, and the harness
 * inside it. Everything here crosses an RPC boundary, so it is plain data.
 */

export interface RunArgs {
  sessionId: string
  /** Playwright storage state to seed a browser that has none yet; null for a browser already in use. */
  storageState: unknown | null
  /** Wall-clock budget for the model's `run`; the probe mode ignores it. */
  timeoutMs: number
  /** How long a minted Live View link should stay valid. */
  liveViewTtlMs: number
  /** True when the caller is done with the browser and wants it closed after the state export. */
  close?: boolean
}

export interface RunResult {
  ok: boolean
  /** `run`'s return value, encoded; absent when it never returned. */
  result?: string
  error?: { message: string; stack?: string }
  timedOut: boolean
  url: string | null
  title: string | null
  /** The context's storage state after the run, for the profile store; null when it could not be read. */
  storageState: unknown | null
  liveView: { url: string; expiresAt: number } | null
  /** Attachment ids the host handed back for each screenshot, in order. */
  screenshots: Array<{ attachmentId: number; name: string }>
}

/** What the harness may ask of the host, through a loopback binding pinned to one generation. */
export interface HostApi {
  log(line: string): Promise<void>
  /** Returns the attachment id the bytes were stored under. */
  attach(name: string, mime: string, bytes: ArrayBuffer): Promise<number>
}

export interface GatewayProps {
  sessionId: string
}

export interface HostProps {
  userId: number
  conversationId: number
  messageId: number
  callId: string
}

/** Payloads the Worker-side host forwards into the Durable Object; see `onHostCall` in the plugin. */
export type HostCall =
  | { kind: 'log'; conversationId: number; messageId: number; callId: string; line: string }
  | { kind: 'attach'; conversationId: number; messageId: number; callId: string; name: string; mime: string; bytes: ArrayBuffer }
