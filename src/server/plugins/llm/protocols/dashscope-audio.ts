import type { FetchFunction } from '@ai-sdk/provider-utils'

/** DashScope input_audio.data takes a URL or data URI, unlike OpenAI's bare Base64 field. */
export function dashscopeAudioFetch(baseURL: string, upstream: FetchFunction = globalThis.fetch): FetchFunction {
  const host = new URL(baseURL).hostname
  if (!['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host) && !host.endsWith('.maas.aliyuncs.com')) return upstream
  return (input, init) => {
    if (typeof init?.body !== 'string') return upstream(input, init)
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
    return upstream(input, changed ? { ...init, body: JSON.stringify(body) } : init)
  }
}
