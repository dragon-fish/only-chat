import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

/**
 * A canned response for the local mock provider: what to stream, and how slowly.
 *
 * The script is built from the text of the last user message. A leading `/directive` picks a shape
 * — a tool call, reasoning, a failure — and anything else produces prose. Malformed directives fall
 * back to prose rather than throwing: this exists to exercise the app by hand, and a typo should
 * not look like a provider outage.
 */
export interface MockScript {
  parts: LanguageModelV4StreamPart[]
  /** Milliseconds between chunks; 0 streams as fast as the runtime allows. */
  delayMs: number
}

const WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit', 'sed', 'do',
  'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore', 'magna', 'aliqua', 'enim',
  'ad', 'minim', 'veniam', 'quis', 'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi',
]

function usage(text: number, reasoning = 0) {
  return {
    inputTokens: { total: 64, noCache: 64, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: text + reasoning, text, reasoning },
    raw: {},
  }
}

function start(): LanguageModelV4StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: `mock-${Date.now()}`, modelId: 'mock', timestamp: new Date() },
  ]
}

function sentence(wordCount: number): string[] {
  const words: string[] = []
  for (let index = 0; index < wordCount; index++) {
    words.push(WORDS[Math.floor(Math.random() * WORDS.length)]!)
  }
  return words
}

/** Deltas rather than one blob, so the UI's streaming path is what gets exercised. */
function prose(wordCount = 40): LanguageModelV4StreamPart[] {
  const words = sentence(wordCount)
  return [
    { type: 'text-start', id: 't1' },
    ...words.map((word, index): LanguageModelV4StreamPart => (
      { type: 'text-delta', id: 't1', delta: index === 0 ? word : ` ${word}` }
    )),
    { type: 'text-end', id: 't1' },
  ]
}

function proseScript(wordCount = 40, delayMs = 0): MockScript {
  const words = prose(wordCount)
  return {
    parts: [...start(), ...words, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(wordCount) }],
    delayMs,
  }
}

function toolCallScript(calls: Array<{ name: string, input: string }>): MockScript {
  const parts: LanguageModelV4StreamPart[] = [...start()]
  for (const [index, call] of calls.entries()) {
    parts.push({
      type: 'tool-call',
      toolCallId: `mock_call_${String(index).padStart(2, '0')}_${Math.random().toString(36).slice(2, 10)}`,
      toolName: call.name,
      input: call.input,
    })
  }
  parts.push({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: usage(calls.length * 8) })
  return { parts, delayMs: 0 }
}

function parseJson(source: string): unknown | undefined {
  try { return JSON.parse(source) }
  catch { return undefined }
}

/** Splits `name rest-of-line` without tokenising the payload — the payload is JSON and owns its own syntax. */
function splitHead(body: string): [string, string] {
  const trimmed = body.trim()
  const boundary = trimmed.search(/\s/)
  return boundary === -1 ? [trimmed, ''] : [trimmed.slice(0, boundary), trimmed.slice(boundary + 1).trim()]
}

export interface MockScriptOptions {
  /**
   * Set once this turn has a tool result. A tool directive then answers in prose instead of calling
   * again, which is what a real model does and what keeps the hub's tool loop from running to its
   * step cap.
   */
  toolsAlreadyRan?: boolean
}

export function buildMockScript(prompt: string, options: MockScriptOptions = {}): MockScript {
  const text = prompt.trim()
  if (!text.startsWith('/')) return proseScript()
  const [head, body] = splitHead(text.slice(1))
  // `/reasoning@300` — any shape, throttled. Streaming is the part of the UI worth looking at and
  // it is over before the eye arrives; `/slow` only ever governed prose.
  const [directive, pace] = head.split('@')
  const paced = Number.parseInt(pace ?? '', 10)
  const throttle = (script: MockScript): MockScript => (
    Number.isFinite(paced) && paced > 0 ? { ...script, delayMs: paced } : script
  )

  if (directive === 'tool_call' || directive === 'parallel') {
    if (options.toolsAlreadyRan) return throttle(proseScript(18))
  }

  if (directive === 'tool_call') {
    const [name, input] = splitHead(body)
    if (!name || parseJson(input) === undefined) return throttle(proseScript())
    return throttle(toolCallScript([{ name, input }]))
  }

  if (directive === 'parallel') {
    const parsed = parseJson(body)
    if (!Array.isArray(parsed)) return throttle(proseScript())
    const calls = parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return []
      const { name, args } = entry as { name?: unknown, args?: unknown }
      return typeof name === 'string' ? [{ name, input: JSON.stringify(args ?? {}) }] : []
    })
    return throttle(calls.length > 0 ? toolCallScript(calls) : proseScript())
  }

  if (directive === 'reasoning') {
    const words = (body || sentence(12).join(' ')).split(/\s+/).filter(Boolean)
    return throttle({
      parts: [
        ...start(),
        { type: 'reasoning-start', id: 'r1' },
        // One delta per word, like prose. Sent as a single blob the block was already finished by
        // the time it appeared, so nothing on screen ever showed thinking in progress.
        ...words.map((word, index): LanguageModelV4StreamPart => (
          { type: 'reasoning-delta', id: 'r1', delta: index === 0 ? word : ` ${word}` }
        )),
        { type: 'reasoning-end', id: 'r1' },
        ...prose(24),
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(24, 12) },
      ],
      delayMs: 0,
    })
  }

  if (directive === 'error') {
    const message = body || 'mock provider failure'
    return throttle({
      parts: [
        ...start(),
        { type: 'error', error: new Error(message) },
        { type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage: usage(0) },
      ],
      delayMs: 0,
    })
  }

  // Kept: `/slow 300` is fewer keystrokes than `/prose@300` for the common case.
  if (directive === 'slow') {
    const ms = Number.parseInt(body, 10)
    return proseScript(40, Number.isFinite(ms) && ms > 0 ? ms : 200)
  }

  return throttle(proseScript())
}
