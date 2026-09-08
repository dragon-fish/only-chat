import type { ProviderOptions } from '@/shared/parts'

export const RESPONSES_PROVIDER_NAME = 'responses'

export interface ResponsesReasoningDelta {
  itemId: string
  kind: 'full' | 'summary'
  text: string
}

export interface ResponsesReasoningBuffers {
  itemId: string
  full?: string
  summary?: string
}

/** Raw events retain the distinction that the SDK's normalized reasoning deltas erase. */
export function readResponsesReasoningDelta(value: unknown): ResponsesReasoningDelta | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const event = value as Record<string, unknown>
  if (typeof event.item_id !== 'string' || typeof event.delta !== 'string') return undefined
  if (event.type === 'response.reasoning_text.delta') return { itemId: event.item_id, kind: 'full', text: event.delta }
  if (event.type === 'response.reasoning_summary_text.delta') return { itemId: event.item_id, kind: 'summary', text: event.delta }
  return undefined
}

export function streamedResponsesReasoningOptions(buffer: ResponsesReasoningBuffers): ProviderOptions {
  return { [RESPONSES_PROVIDER_NAME]: {
    itemId: buffer.itemId,
    reasoningContent: buffer.full === undefined ? null : [{ type: 'reasoning_text', text: buffer.full }],
    ...(buffer.summary === undefined ? {} : { reasoningSummary: [{ type: 'summary_text', text: buffer.summary }] }),
  } }
}

function joinedText(value: unknown, type: 'reasoning_text' | 'summary_text'): string | undefined {
  if (!Array.isArray(value)) return undefined
  let text = ''
  for (const part of value) {
    if (part === null || typeof part !== 'object' || part.type !== type || typeof part.text !== 'string') return undefined
    text += part.text
  }
  return text
}

/** Explicit completed content wins; omitted content is rebuilt only from a known raw source. */
export function completedResponsesReasoningOptions(options: ProviderOptions | undefined, buffer: ResponsesReasoningBuffers): ProviderOptions {
  const metadata = options?.[RESPONSES_PROVIDER_NAME] ?? {}
  if (typeof metadata.itemId === 'string' && metadata.itemId !== buffer.itemId) throw new Error('Responses reasoning item does not match its stream')
  const content = joinedText(metadata.reasoningContent, 'reasoning_text')
  const hasContent = Array.isArray(metadata.reasoningContent) && metadata.reasoningContent.length > 0 && content !== undefined
  const summary = joinedText(metadata.reasoningSummary, 'summary_text')
  return { ...options, [RESPONSES_PROVIDER_NAME]: {
    ...metadata,
    itemId: buffer.itemId,
    ...(!hasContent && buffer.full !== undefined ? { reasoningContent: [{ type: 'reasoning_text', text: buffer.full }] } : {}),
    ...(!summary && buffer.summary !== undefined ? { reasoningSummary: [{ type: 'summary_text', text: buffer.summary }] } : {}),
  } }
}

/** The SDK sends summary and full-text deltas through one ID; final content defines its meaning. */
export function completedResponsesReasoningText(text: string, options: ProviderOptions | undefined): string {
  const metadata = options?.[RESPONSES_PROVIDER_NAME]
  if (!metadata) return text
  const content = joinedText(metadata.reasoningContent, 'reasoning_text')
  if (Array.isArray(metadata.reasoningContent) && metadata.reasoningContent.length > 0 && content !== undefined) return content
  const summary = joinedText(metadata.reasoningSummary, 'summary_text')
  return summary || text
}

/** Missing content must not suppress known full plaintext; a summary is never promoted to it. */
export function responsesReasoningReplayOptions(text: string, options: ProviderOptions | undefined): ProviderOptions | undefined {
  const metadata = options?.[RESPONSES_PROVIDER_NAME]
  if (!metadata || text.length === 0 || metadata.reasoningContent != null) return options
  const summary = joinedText(metadata.reasoningSummary, 'summary_text')
  if (summary) {
    return Object.hasOwn(metadata, 'reasoningContent') ? options : {
      ...options, [RESPONSES_PROVIDER_NAME]: { ...metadata, reasoningContent: null },
    }
  }
  if ((metadata.reasoningSummary != null && summary !== '') || !Object.hasOwn(metadata, 'reasoningContent')) return options
  const replay = { ...metadata }
  // The SDK checks property presence before falling back to part.text, even for a null value.
  delete replay.reasoningContent
  return { ...options, [RESPONSES_PROVIDER_NAME]: replay }
}
