import type { FetchFunction } from '@ai-sdk/provider-utils'

/**
 * DashScope input_audio.data takes a URL or data URI, unlike OpenAI's bare Base64 field.
 *
 * Any other host gets `upstream` back untouched, `undefined` included, so the SDK keeps reading
 * `globalThis.fetch` per request. Do not default `upstream` to `globalThis.fetch` here: that pins
 * the function at model creation and bypasses anything that replaces it later, test doubles included.
 */
export function dashscopeAudioFetch(baseURL: string, upstream?: FetchFunction): FetchFunction | undefined {
  const host = new URL(baseURL).hostname
  if (!['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host) && !host.endsWith('.maas.aliyuncs.com')) return upstream
  const send: FetchFunction = upstream ?? ((input, init) => globalThis.fetch(input, init))
  return (input, init) => {
    if (typeof init?.body !== 'string') return send(input, init)
    const body = JSON.parse(init.body)
    let changed = false
    for (const message of body.messages ?? []) {
      if (message.role !== 'user' || !Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type !== 'input_audio') continue
        const audio = part.input_audio
        if (typeof audio?.data !== 'string' || !['mp3', 'wav'].includes(audio.format)) continue
        if (audio.data.startsWith('data:') || /^https?:\/\//.test(audio.data)) continue
        audio.data = `data:audio/${audio.format};base64,${audio.data}`
        changed = true
      }
    }
    return send(input, changed ? { ...init, body: JSON.stringify(body) } : init)
  }
}
