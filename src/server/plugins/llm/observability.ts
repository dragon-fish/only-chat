import type { FetchFunction } from '@ai-sdk/provider-utils'
import type { InterfaceProtocol } from '@/shared/models'

export interface LlmRequestTrace {
  sessionId: number
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

/** Logs enough to compare request prefixes without recording prompts, tool arguments, or reasoning. */
export function observedProviderFetch(trace: LlmRequestTrace, fingerprintKey: string, originalFetch: FetchFunction = globalThis.fetch): FetchFunction {
  return async (input, init) => {
    const startedAt = performance.now()
    if (typeof init?.body === 'string') {
      try {
        console.info(JSON.stringify({ event: 'llm.provider.request', ...trace, request: await summarizeProviderRequest(init.body, fingerprintKey) }))
      } catch (error) {
        console.warn(JSON.stringify({ event: 'llm.provider.request_summary_failed', ...trace, error: error instanceof Error ? error.message : String(error) }))
      }
    }
    try {
      const response = await originalFetch(input, init)
      console.info(JSON.stringify({
        event: 'llm.provider.response', ...trace, status: response.status,
        durationMs: Math.max(0, performance.now() - startedAt),
      }))
      return response
    } catch (error) {
      console.error(JSON.stringify({
        event: 'llm.provider.fetch_failed', ...trace,
        durationMs: Math.max(0, performance.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
  }
}
