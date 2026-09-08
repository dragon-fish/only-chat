import { describe, expect, it, vi } from 'vitest'
import type { SharedV4ProviderReference } from '@ai-sdk/provider'
import { createFileAwareResponsesModel, restoreOpenAIFileReferences } from '@/server/plugins/llm/files/references'

const marker = 'https://only-chat.invalid/files/test-marker'

describe('Responses file request boundary', () => {
  it('restores nested file and image references without changing ordinary URLs, data, or text', () => {
    const imageMarker = 'https://only-chat.invalid/files/image-marker'
    const body = { input: [{ type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'https://only-chat.invalid/files/unrelated' },
      { type: 'input_file', file_url: marker },
      { type: 'input_image', image_url: imageMarker },
      { type: 'input_image', image_url: 'https://host.test/image.png?a=%2f#raw' },
      { type: 'input_file', file_data: 'data:application/pdf;base64,AQIDBA==' },
    ] }], metadata: { untouched: 'file-first' } }
    expect(JSON.parse(restoreOpenAIFileReferences(JSON.stringify(body), new Map([[marker, 'file-first'], [imageMarker, 'file-second']]), 'responses'))).toEqual({
      input: [{ type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'https://only-chat.invalid/files/unrelated' },
        { type: 'input_file', file_id: 'file-first' },
        { type: 'input_image', file_id: 'file-second' },
        { type: 'input_image', image_url: 'https://host.test/image.png?a=%2f#raw' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,AQIDBA==' },
      ] }], metadata: { untouched: 'file-first' },
    })
  })

  it.each([
    { input: [] },
    { input: [{ type: 'input_file', renamed_url: marker }] },
    { input: [{ type: 'input_file', file_url: marker }], metadata: { unexpected: marker } },
    { input: [{ type: 'input_file', file_url: marker }, { type: 'input_file', file_url: marker }] },
  ])('fails before forwarding if the SDK loses, moves, or duplicates a marker (%j)', body => {
    expect(() => restoreOpenAIFileReferences(JSON.stringify(body), new Map([[marker, 'file-first']]), 'responses')).toThrow(/reference/)
  })

  it('rejects a foreign or empty reference without calling fetch', async () => {
    const remote = vi.fn()
    const model = createFileAwareResponsesModel({ name: 'responses', url: 'https://provider.example/responses', fetch: remote }, 'test-model')
    const references: SharedV4ProviderReference[] = [{ anthropic: 'file-foreign' }, { openai: '' }]
    for (const reference of references) {
      await expect(model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', data: { type: 'reference', reference } }] }] })).rejects.toThrow(/OpenAI file reference/)
    }
    expect(remote).not.toHaveBeenCalled()
  })

  it('returns a live SDK stream before the response body finishes', async () => {
    let closeBody!: () => void
    const body = new ReadableStream<Uint8Array>({ start(controller) { closeBody = () => controller.close() } })
    const model = createFileAwareResponsesModel({
      name: 'responses', url: 'https://provider.example/responses',
      fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    }, 'test-model')
    const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', data: { type: 'reference', reference: { openai: 'file-live' } } }] }] })
    const reader = result.stream.getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'stream-start' })
    closeBody()
    await reader.cancel()
  })
})
