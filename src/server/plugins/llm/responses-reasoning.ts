import type { ProviderOptions } from '@/shared/parts'

export const RESPONSES_PROVIDER_NAME = 'responses'

function joinedText(value: unknown, type: 'reasoning_text' | 'summary_text'): string | undefined {
  if (!Array.isArray(value)) return undefined
  let text = ''
  for (const part of value) {
    if (part === null || typeof part !== 'object' || part.type !== type || typeof part.text !== 'string') return undefined
    text += part.text
  }
  return text
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
