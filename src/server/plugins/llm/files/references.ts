import { createOpenResponses, type OpenResponsesProviderSettings } from '@ai-sdk/open-responses'
import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from '@ai-sdk/openai-compatible'
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchFunction } from '@ai-sdk/provider-utils'

type FileReferenceProtocol = 'responses' | 'chat-completions'
type ChatFileReferenceStyle = 'nested' | 'flat'

/** Only request-local URL markers may become file IDs; an SDK shape change must fail closed. */
export function restoreOpenAIFileReferences(
  body: string,
  references: ReadonlyMap<string, string>,
  protocol: FileReferenceProtocol,
  chatStyle: ChatFileReferenceStyle = 'nested',
): string {
  const restored = new Set<string>()
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (value === null || typeof value !== 'object') return value
    const record = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]))
    const urlKey = record.type === 'input_file' ? 'file_url' : record.type === 'input_image' ? 'image_url' : undefined
    const image = record.image_url
    const marker = protocol === 'responses'
      ? urlKey === undefined ? undefined : record[urlKey]
      : record.type === 'image_url' && image !== null && typeof image === 'object' && 'url' in image ? image.url : undefined
    if (typeof marker === 'string' && references.has(marker)) {
      if (restored.has(marker)) throw new Error('OpenAI file reference was duplicated during serialization')
      restored.add(marker)
      if (protocol === 'responses') {
        delete record[urlKey!]
        record.file_id = references.get(marker)
      } else {
        delete record.image_url
        record.type = 'file'
        if (chatStyle === 'flat') record.file_id = references.get(marker)
        else record.file = { file_id: references.get(marker) }
      }
    }
    return record
  }
  const result = JSON.stringify(visit(JSON.parse(body)))
  if (restored.size !== references.size || [...references.keys()].some(marker => result.includes(marker))) {
    throw new Error('OpenAI file reference was not preserved during serialization')
  }
  return result
}

/**
 * Open Responses 2.0.39 and OpenAI Compatible 3.0.43 reject native references before fetch. Their
 * public V4 model and fetch interfaces translate just those inputs; output/reasoning use the SDK.
 * Never share the marker map across calls or read/buffer the response body here.
 */
function withOpenAIFileReferences(
  createModel: (fetch?: FetchFunction) => LanguageModelV4,
  protocol: FileReferenceProtocol,
  originalFetch?: FetchFunction,
  chatStyle: ChatFileReferenceStyle = 'nested',
): LanguageModelV4 {
  const sdk = createModel()
  const prepare = (options: LanguageModelV4CallOptions) => {
    const references = new Map<string, string>()
    const prompt: LanguageModelV4Prompt = options.prompt.map(message => {
      if (message.role !== 'user') return message
      return { ...message, content: message.content.map(part => {
        if (part.type !== 'file' || part.data.type !== 'reference') return part
        const id = part.data.reference.openai
        if (typeof id !== 'string' || id.trim() === '') throw new Error('Missing OpenAI file reference')
        const url = new URL(`https://only-chat.invalid/files/${crypto.randomUUID()}`)
        references.set(url.toString(), id)
        // Chat accepts URL images but rejects URL documents. The marker's temporary media type
        // never reaches the provider; the adapter restores the selected provider's file-id shape.
        return { ...part, ...(protocol === 'chat-completions' ? { mediaType: 'image/png' } : {}), data: { type: 'url', url } }
      }) }
    })
    if (references.size === 0) return { model: sdk, options }
    const model = createModel((input, init) => {
      if (typeof init?.body !== 'string') throw new Error('OpenAI file references require a JSON request body')
      const body = restoreOpenAIFileReferences(init.body, references, protocol, chatStyle)
      return (originalFetch ?? globalThis.fetch)(input, { ...init, body })
    })
    return { model, options: { ...options, prompt } }
  }
  return {
    specificationVersion: sdk.specificationVersion,
    provider: sdk.provider,
    modelId: sdk.modelId,
    supportedUrls: sdk.supportedUrls,
    async doGenerate(options) {
      const call = prepare(options)
      return call.model.doGenerate(call.options)
    },
    async doStream(options) {
      const call = prepare(options)
      return call.model.doStream(call.options)
    },
  }
}

export function createFileAwareResponsesModel(settings: OpenResponsesProviderSettings, modelId: string): LanguageModelV4 {
  return withOpenAIFileReferences(fetch => createOpenResponses({ ...settings, ...(fetch ? { fetch } : {}) })(modelId), 'responses', settings.fetch)
}

export function createFileAwareChatModel(
  settings: OpenAICompatibleProviderSettings,
  modelId: string,
  options: { fileReferenceStyle?: ChatFileReferenceStyle } = {},
): LanguageModelV4 {
  return withOpenAIFileReferences(
    fetch => createOpenAICompatible({ ...settings, ...(fetch ? { fetch } : {}) }).chatModel(modelId),
    'chat-completions', settings.fetch, options.fileReferenceStyle,
  )
}
