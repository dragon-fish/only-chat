/**
 * Whether a provider error means the request did not fit the model's context window (spec §3.3).
 *
 * The pattern table is ported from pi (badlogic/pi-mono, packages/ai/src/utils/overflow.ts, MIT),
 * which collects the wording each provider uses. Pi also detects silent overflow from usage; that
 * needs a successful response, which the core never hands to `isOverflow`, so only the error half
 * is ported.
 */
const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic and z.ai token overflow
  /prompt exceeds max length/i, // z.ai CN endpoint token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (most backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /range of input length should be/i, // DashScope / Qwen
  /context[_ ]length[_ ]exceeded/i, // generic
  /too many tokens/i, // generic
  /token limit exceeded/i, // generic
]

/**
 * Wording that is never an overflow even when an overflow pattern also matches — Bedrock throttling
 * reads "ThrottlingException: Too many tokens, please wait before trying again."
 */
const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(?:Throttling error|Service unavailable):/i,
  /throttl/i,
  /rate[_ ]?limit/i,
  /too many requests/i,
]

/** Cerebras answers an oversized request with a bare status line and no body. */
const BODYLESS_OVERFLOW = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i

/** How deep to follow `cause` and retry wrappers; an error chain is never legitimately longer. */
const MAX_DEPTH = 5

/** The texts an error carries: its message and response body, then those of what it wraps. */
function errorTexts(error: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || error === null || error === undefined) return out
  if (typeof error === 'string') {
    out.push(error)
    return out
  }
  if (typeof error !== 'object') return out
  const record = error as Record<string, unknown>
  if (typeof record.message === 'string') out.push(record.message)
  // `APICallError` keeps the provider's own wording in the body; the message is often generic.
  if (typeof record.responseBody === 'string') out.push(record.responseBody)
  if (record.data !== undefined && typeof record.data === 'object') {
    try {
      out.push(JSON.stringify(record.data))
    } catch { /* unserializable data carries nothing to match */ }
  }
  errorTexts(record.cause, depth + 1, out)
  // `RetryError` wraps the attempts it made.
  errorTexts(record.lastError, depth + 1, out)
  if (Array.isArray(record.errors)) for (const inner of record.errors) errorTexts(inner, depth + 1, out)
  return out
}

/** Whether a request status says rate limiting, which an overflow pattern must never override. */
function isRateLimited(error: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || error === null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (record.statusCode === 429) return true
  return isRateLimited(record.cause, depth + 1) || isRateLimited(record.lastError, depth + 1)
}

export function isContextOverflow(error: unknown): boolean {
  if (isRateLimited(error)) return false
  const texts = errorTexts(error)
  if (texts.some(text => NON_OVERFLOW_PATTERNS.some(pattern => pattern.test(text)))) return false
  return texts.some(text => OVERFLOW_PATTERNS.some(pattern => pattern.test(text)) || BODYLESS_OVERFLOW.test(text.trim()))
}
