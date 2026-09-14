import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'

/**
 * A canned response for the local mock provider: what to stream, and how slowly.
 *
 * Written as a macro rather than one directive. Every line beginning with `/` is a step and they
 * run top to bottom, so a single message can lay out a whole turn — think, call a tool, say
 * something, call another — and the app renders exactly the shape being worked on. A message whose
 * lines are not directives is prose, as before, and a malformed step is dropped rather than thrown:
 * this exists to exercise the app by hand, and a typo should not look like a provider outage.
 *
 * A step may be paced with `@ms` (`/reasoning@150 …`). Pacing is per part rather than per script,
 * because one segment can hold a slow thought and fast prose and each should look like what it is.
 */
export interface MockScript {
  parts: LanguageModelV4StreamPart[]
  /** Milliseconds to wait before each part, aligned with `parts`. */
  delays: number[]
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

/** `/content 40` asks for forty words; `/content 说点什么` asks for those words. */
function bodyWords(body: string, fallbackCount: number): string[] {
  const trimmed = body.trim()
  if (/^\d+$/.test(trimmed)) {
    const count = Number.parseInt(trimmed, 10)
    if (count > 0) return sentence(Math.min(count, 400))
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  return words.length > 0 ? words : sentence(fallbackCount)
}

/** Deltas rather than one blob, so the UI's streaming path is what gets exercised. */
function textParts(words: readonly string[], id: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id },
    ...words.map((word, index): LanguageModelV4StreamPart => (
      { type: 'text-delta', id, delta: index === 0 ? word : ` ${word}` }
    )),
    { type: 'text-end', id },
  ]
}

function reasoningParts(words: readonly string[], id: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'reasoning-start', id },
    // One delta per word, like prose. Sent as a single blob the block was already finished by the
    // time it appeared, so nothing on screen ever showed thinking in progress.
    ...words.map((word, index): LanguageModelV4StreamPart => (
      { type: 'reasoning-delta', id, delta: index === 0 ? word : ` ${word}` }
    )),
    { type: 'reasoning-end', id },
  ]
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
   * How many tool results this turn has already produced.
   *
   * A macro is one list of steps, but a tool call ends the model's turn: the hub runs the tool and
   * comes back for more. So the steps are handed out a segment at a time, one per call, and this is
   * the bookmark. Without it the mock would replay from the top on every step, to the step cap.
   */
  toolResults?: number
}

/** One line of a macro. */
interface Step {
  kind: 'reasoning' | 'content' | 'tool' | 'error'
  body: string
  delayMs: number
  /** For `tool`: the calls this line makes. */
  calls?: Array<{ name: string, input: string }>
  /** `/slow` means a paced paragraph of filler, not a paragraph of the word "300". */
  filler?: boolean
  /** Emit `body` exactly as written, rather than a delta per word. */
  verbatim?: boolean
}

/**
 * The directives, as data.
 *
 * A table rather than a chain of name comparisons, so `/help` can be generated from the same thing
 * that parses them. Written as a chain, help is a second list that drifts from the first — and a
 * mock nobody can remember the syntax of is a mock nobody uses.
 */
interface Directive {
  name: string
  usage: string
  summary: string
  /** Returns the step, or null when the line is malformed and should be dropped. */
  parse: (body: string, delayMs: number) => Step | null
}

const DIRECTIVES: Directive[] = [
  {
    name: 'reasoning',
    usage: '/reasoning[@毫秒] <词数 | 文字>',
    summary: '一段思考。给数字就是词数，给文字就用这些文字。',
    parse: (body, delayMs) => ({ kind: 'reasoning', body, delayMs }),
  },
  {
    name: 'content',
    usage: '/content[@毫秒] <词数 | 文字>',
    summary: '一段正文，同样接受词数或文字。',
    parse: (body, delayMs) => ({ kind: 'content', body, delayMs }),
  },
  {
    name: 'tool_call',
    usage: '/tool_call[@毫秒] <工具名> <JSON 参数>',
    summary: '调用一个工具。调用会结束本轮，宏从下一行继续。',
    parse: (body, delayMs) => {
      const [tool, input] = splitHead(body)
      if (!tool || parseJson(input) === undefined) return null
      return { kind: 'tool', body, delayMs, calls: [{ name: tool, input }] }
    },
  },
  {
    name: 'parallel',
    usage: '/parallel[@毫秒] [{"name":"工具名","args":{}}, …]',
    summary: '一次发起多个工具调用。',
    parse: (body, delayMs) => {
      const parsed = parseJson(body)
      if (!Array.isArray(parsed)) return null
      const calls = parsed.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const { name: tool, args } = entry as { name?: unknown, args?: unknown }
        return typeof tool === 'string' ? [{ name: tool, input: JSON.stringify(args ?? {}) }] : []
      })
      return calls.length === 0 ? null : { kind: 'tool', body, delayMs, calls }
    },
  },
  {
    name: 'error',
    usage: '/error <消息>',
    summary: '让这一轮以上游失败收场。',
    parse: (body, delayMs) => ({ kind: 'error', body, delayMs }),
  },
  {
    name: 'slow',
    usage: '/slow <毫秒>',
    summary: '一段限速的填充正文，等同 /content@毫秒 40。',
    parse: (body) => {
      const ms = Number.parseInt(body, 10)
      return { kind: 'content', body: '40', delayMs: Number.isFinite(ms) && ms > 0 ? ms : 200, filler: true }
    },
  },
  {
    name: 'help',
    usage: '/help',
    summary: '列出所有指令。',
    parse: (_body, delayMs) => ({ kind: 'content', body: helpText(), delayMs, verbatim: true }),
  },
]

function helpText(): string {
  const rows = DIRECTIVES.map(directive => `| \`${directive.usage}\` | ${directive.summary} |`)
  return [
    'Mock 指令表。每个以 `/` 开头的行是一步，从上往下依次执行；不以 `/` 开头的行会被忽略，可以当注释写。',
    '',
    '| 用法 | 说明 |',
    '| --- | --- |',
    ...rows,
    '',
    '`@毫秒` 给这一步限速，例如 `/reasoning@150`。限速是逐步的，慢思考后面可以跟快正文。',
  ].join('\n')
}

function parseSteps(text: string): Step[] {
  const steps: Step[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('/')) continue
    const [head, body] = splitHead(trimmed.slice(1))
    const [name, pace] = head.split('@')
    const paced = Number.parseInt(pace ?? '', 10)
    const delayMs = Number.isFinite(paced) && paced > 0 ? paced : 0

    const directive = DIRECTIVES.find(entry => entry.name === name)
    const step = directive?.parse(body, delayMs)
    if (step) steps.push(step)
  }
  return steps
}

/** The steps of one model turn: everything up to and including the nth tool call. */
function segmentAt(steps: readonly Step[], index: number): Step[] | null {
  const segments: Step[][] = [[]]
  for (const step of steps) {
    segments.at(-1)!.push(step)
    if (step.kind === 'tool') segments.push([])
  }
  // A trailing empty segment means the macro ended on a tool call and has nothing more to say.
  if (segments.at(-1)!.length === 0) segments.pop()
  return segments[index] ?? null
}

function proseScript(wordCount = 40, delayMs = 0): MockScript {
  const parts = [
    ...start(),
    ...textParts(sentence(wordCount), 't1'),
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(wordCount) },
  ]
  return { parts, delays: parts.map(() => delayMs) }
}

export function buildMockScript(prompt: string, options: MockScriptOptions = {}): MockScript {
  const steps = parseSteps(prompt.trim())
  if (steps.length === 0) return proseScript()

  const segment = segmentAt(steps, options.toolResults ?? 0)
  // The macro is spent, so the turn says nothing. Filler here used to stand in for a closing
  // remark, but a macro that ends on a tool call ends there on purpose, and a paragraph of lorem
  // after it is noise in the one place the shape was being read. Segmenting is what keeps the
  // hub's loop from replaying the macro to the step cap; the prose was never doing that.
  if (segment === null) {
    const parts = [...start(), { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: usage(0) }]
    return { parts, delays: parts.map(() => 0) }
  }

  const parts: LanguageModelV4StreamPart[] = [...start()]
  const delays: number[] = parts.map(() => 0)
  const push = (added: LanguageModelV4StreamPart[], delayMs: number) => {
    for (const part of added) { parts.push(part); delays.push(delayMs) }
  }

  let textWords = 0
  let reasoningWords = 0
  let blockId = 0
  for (const step of segment) {
    blockId += 1
    if (step.kind === 'reasoning') {
      const words = bodyWords(step.body, 12)
      reasoningWords += words.length
      push(reasoningParts(words, `r${blockId}`), step.delayMs)
      continue
    }
    if (step.kind === 'content') {
      if (step.verbatim) {
        // One delta. Splitting on whitespace would join the help table's rows into a paragraph.
        textWords += 1
        push([
          { type: 'text-start', id: `t${blockId}` },
          { type: 'text-delta', id: `t${blockId}`, delta: step.body },
          { type: 'text-end', id: `t${blockId}` },
        ], step.delayMs)
        continue
      }
      const words = step.filler ? sentence(40) : bodyWords(step.body, 24)
      textWords += words.length
      push(textParts(words, `t${blockId}`), step.delayMs)
      continue
    }
    if (step.kind === 'error') {
      push([{ type: 'error', error: new Error(step.body || 'mock provider failure') }], step.delayMs)
      push([{ type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage: usage(0) }], 0)
      return { parts, delays }
    }
    for (const [index, call] of (step.calls ?? []).entries()) {
      push([{
        type: 'tool-call',
        toolCallId: `mock_call_${String(index).padStart(2, '0')}_${Math.random().toString(36).slice(2, 10)}`,
        toolName: call.name,
        input: call.input,
      }], step.delayMs)
    }
    push([{
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: usage((step.calls?.length ?? 0) * 8),
    }], 0)
    return { parts, delays }
  }

  push([{ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(textWords, reasoningWords) }], 0)
  return { parts, delays }
}
