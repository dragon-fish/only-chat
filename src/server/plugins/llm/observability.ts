import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { InterfaceProtocol } from '@/shared/models'

export interface LlmRequestTrace {
  conversationId: number
  messageId: number
  providerId: number
  interfaceId: number
  protocol: InterfaceProtocol
  modelId: string
}

const encoder = new TextEncoder()

async function signer(secret: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return async (value: string) => {
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
    return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }
}

function stringChars(value: unknown): number {
  if (typeof value === 'string') return Array.from(value).length
  if (Array.isArray(value)) return value.reduce((total, item) => total + stringChars(item), 0)
  if (value !== null && typeof value === 'object') return Object.values(value).reduce((total, item) => total + stringChars(item), 0)
  return 0
}

export async function summarizeProviderRequest(body: string, fingerprintKey: string) {
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Provider request body must be an object')
  const request = parsed as Record<string, unknown>
  const format = Array.isArray(request.input) ? 'responses' : Array.isArray(request.messages) ? 'chat-completions' : 'unknown'
  const items = format === 'responses' ? request.input : format === 'chat-completions' ? request.messages : []
  const sign = await signer(fingerprintKey)
  return {
    format,
    model: typeof request.model === 'string' ? request.model : null,
    topLevelKeys: Object.keys(request).sort(),
    bodyFingerprint: await sign(body),
    items: await Promise.all((items as unknown[]).map(async (item) => {
      const record = item !== null && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {}
      return {
        type: typeof record.type === 'string' ? record.type : null,
        role: typeof record.role === 'string' ? record.role : null,
        stringChars: stringChars(item),
        fingerprint: await sign(JSON.stringify(item)),
      }
    })),
  }
}

/**
 * The one line a log list shows; everything else is filed away as a filterable attribute.
 *
 * Only identifiers, never the request itself — the same line the summary draws.
 */
function line(event: string, trace: LlmRequestTrace, extra: Record<string, string | number> = {}): string {
  const pairs = Object.entries({
    conversation_id: trace.conversationId, message_id: trace.messageId,
    provider_id: trace.providerId, model: trace.modelId, ...extra,
  }).map(([key, value]) => `${key}=${value}`)
  return [`[${event}]`, ...pairs].join(' ')
}

/** Logs enough to compare request prefixes without recording prompts, tool arguments, or reasoning. */
export function observedProviderFetch(trace: LlmRequestTrace, fingerprintKey: string, originalFetch: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const startedAt = performance.now()
    if (typeof init?.body === 'string') {
      try {
        const request = await summarizeProviderRequest(init.body, fingerprintKey)
        console.info({
          message: line('llm.provider.request', trace, { items: request.items.length, chars: init.body.length }),
          event: 'llm.provider.request', ...trace, request,
        })
      } catch (error) {
        console.warn({
          message: line('llm.provider.request_summary_failed', trace),
          event: 'llm.provider.request_summary_failed', ...trace,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    try {
      const response = await originalFetch(input, init)
      const durationMs = Math.round(Math.max(0, performance.now() - startedAt))
      console.info({
        message: line('llm.provider.response', trace, { status: response.status, duration_ms: durationMs }),
        event: 'llm.provider.response', ...trace, status: response.status, durationMs,
      })
      return response
    } catch (error) {
      const durationMs = Math.round(Math.max(0, performance.now() - startedAt))
      console.error({
        message: line('llm.provider.fetch_failed', trace, { duration_ms: durationMs }),
        event: 'llm.provider.fetch_failed', ...trace, durationMs,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
