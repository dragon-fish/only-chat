import type { Message, Usage } from '@/shared/models'
import type { WsEvent } from '@/shared/ws'

/** A server event and how long to wait before sending it. */
export interface Timed {
  delay: number
  event: WsEvent
}

export type TurnStep =
  | { kind: 'reasoning'; text: string; durationMs: number }
  | { kind: 'text'; text: string }
  /** A call and its result: two parts, the result arriving `runMs` after the call. */
  | { kind: 'tool'; id: string; name: string; args: unknown; content: unknown; runMs: number }

const TEXT_CHUNK = 3
const TEXT_DELAY = 45
const REASONING_DELAY = 25

/** Splits on code points so a chunk never cuts a character in half. */
export function chunks(text: string, size: number): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/**
 * The frames the real hub's accumulator produces for one assistant turn: an empty part opens each
 * block, deltas fill text and reasoning, the finished part closes it, and `message.done` ends the
 * turn. Part indexes count up across steps the way they do on the server.
 */
export function assistantFrames(messageId: number, steps: TurnStep[], usage: Usage): Timed[] {
  const frames: Timed[] = []
  const at = (delay: number, event: WsEvent) => { frames.push({ delay, event }) }
  let index = 0
  for (const step of steps) {
    if (step.kind === 'tool') {
      at(200, { type: 'message.part', message_id: messageId, part_index: index, part: { type: 'tool_call', id: step.id, name: step.name, args: step.args } })
      at(step.runMs, { type: 'message.part', message_id: messageId, part_index: index + 1, part: { type: 'tool_result', call_id: step.id, name: step.name, content: step.content } })
      index += 2
      continue
    }
    const kind = step.kind
    at(120, { type: 'message.part', message_id: messageId, part_index: index, part: { type: kind, text: '' } })
    for (const delta of chunks(step.text, TEXT_CHUNK)) {
      at(kind === 'reasoning' ? REASONING_DELAY : TEXT_DELAY, { type: 'message.delta', message_id: messageId, part_index: index, kind, delta })
    }
    at(0, {
      type: 'message.part', message_id: messageId, part_index: index,
      part: kind === 'reasoning' ? { type: 'reasoning', text: step.text, duration_ms: step.durationMs } : { type: 'text', text: step.text },
    })
    index += 1
  }
  at(80, { type: 'message.done', message_id: messageId, status: 'done', usage, error: null })
  return frames
}

/** An assistant row as the hub opens it, before any part has streamed. */
export function assistantShell(message: Pick<Message, 'id' | 'conversation_id' | 'parent_id' | 'seq' | 'provider_id' | 'model_id' | 'created_at'>): Message {
  return { ...message, role: 'assistant', parts: [], usage: null, status: 'streaming', error: 'interrupted', notes: null }
}
