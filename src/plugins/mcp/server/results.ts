import type { CallToolResult } from '@ai-sdk/mcp'
import type { McpCallToolOutput, McpOtherContent } from '../shared'

export const MAX_RESULT_TEXT = 64 * 1024
const MAX_IMAGES = 8

export interface DecodedImage {
  bytes: Uint8Array
  mime: string
}

export interface MappedCallResult {
  output: Omit<McpCallToolOutput, 'service_id' | 'tool_name' | 'images'>
  images: DecodedImage[]
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Text is joined and capped; images become bytes for the caller to store, because D1, the DO
 * snapshot and every WebSocket frame carry attachment ids and never base64. Anything else is
 * described with its payload left out — a blob can be megabytes the model cannot use as text.
 */
export function mapCallResult(result: CallToolResult): MappedCallResult {
  if (!('content' in result)) {
    // The pre-2025 shape: a bare `toolResult`, passed through as structured data.
    return { output: { is_error: false, text: '', other: [], structured: (result as { toolResult?: unknown }).toolResult }, images: [] }
  }
  const texts: string[] = []
  const images: DecodedImage[] = []
  const other: McpOtherContent[] = []
  for (const item of result.content as Array<Record<string, unknown> & { type: string }>) {
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string' && images.length < MAX_IMAGES) {
      images.push({ bytes: decodeBase64(item.data), mime: item.mimeType })
    }
    else if (item.type === 'resource' && item.resource && typeof item.resource === 'object') {
      const resource = item.resource as { uri?: string, mimeType?: string, text?: string, blob?: string }
      if (typeof resource.text === 'string') texts.push(resource.text)
      else other.push({ type: 'resource', uri: resource.uri, mime: resource.mimeType, note: 'binary content omitted' })
    }
    else {
      const { data: _data, blob: _blob, ...rest } = item
      other.push(rest)
    }
  }
  const text = texts.join('\n\n')
  const truncated = text.length > MAX_RESULT_TEXT
  return {
    output: {
      is_error: result.isError === true,
      text: truncated ? text.slice(0, MAX_RESULT_TEXT) : text,
      ...(truncated ? { text_truncated: { original_length: text.length } } : {}),
      other,
      ...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
    },
    images,
  }
}
