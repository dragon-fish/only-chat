import type { Part, ToolCallPart, ToolResultPart } from '@/shared/parts'

/** Whether a recorded result means the person moved on without answering that tool. */
export type SkippedResult = (toolName: string, content: unknown) => boolean

/**
 * Whether a halted turn may resume.
 *
 * Only tools the server cannot answer are consulted, and what a skip looks like is theirs to say.
 * A model may call `ask_user` in the same step as tools that execute — DeepSeek does, six at a
 * time — and those already carry their results, which say nothing about whether the person is
 * done. Treating every call as one the human owns threw `unsupported pending tool: web_search` the
 * moment a model did that.
 *
 * Lives apart from the generation pipeline because it is a pure rule about parts, and a rule this
 * easy to get wrong should be testable without a Durable Object around it.
 */
export function completedToolState(parts: readonly Part[], skipped: SkippedResult): 'waiting' | 'cancelled' | 'answered' {
  const calls = parts.filter((part): part is ToolCallPart => part.type === 'tool_call')
  if (calls.length === 0) throw new Error('message has no tool calls')
  const results = new Map(
    parts.filter((part): part is ToolResultPart => part.type === 'tool_result').map(part => [part.call_id, part]),
  )
  if (calls.some(call => !results.has(call.id))) return 'waiting'
  if (calls.some(call => skipped(call.name, results.get(call.id)!.content))) return 'cancelled'
  return 'answered'
}
