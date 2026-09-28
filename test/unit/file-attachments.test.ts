import { describe, expect, it } from 'vitest'
import { PartSchema } from '@/shared/parts'
import { toolImagesMessage, type AttachmentInput } from '@/server/plugins/llm/messages'

describe('file attachments', () => {
  it('preserves a non-image attachment through message validation', () => {
    const part = { type: 'file', attachment_id: 12, mime: 'audio/mpeg', filename: 'recording.mp3' }
    expect(PartSchema.safeParse(part).success).toBe(true)
    expect(PartSchema.parse(part)).toEqual(part)
  })

  it('delivers a PDF in a user message correlated to its tool receipt', () => {
    const file: AttachmentInput = { mime: 'application/pdf', data: { type: 'reference', reference: { fileId: 'file-pdf' } } }
    const message = toolImagesMessage([
      { type: 'tool_result', call_id: 'call-1', name: 'read_file', content: { request_id: 'read-123', message: 'File follows.' }, attachments: [12] },
    ], new Map([[12, file]]))
    expect(message).toEqual({ role: 'user', content: [
      { type: 'text', text: '<read_file_result id="read-123">' },
      { type: 'file', mediaType: 'application/pdf', filename: 'attachment-12.pdf', data: file.data },
      { type: 'text', text: '</read_file_result>' },
    ] })
  })
})

it('does not send unavailable file bytes to a text-only model', () => {
  const file = { mime: 'audio/mpeg', data: { type: 'data' as const, data: new Uint8Array([1, 2]) }, unavailable: 'Use analyze_file for this file.' }
  const message = toolImagesMessage([
    { type: 'tool_result', call_id: 'call-2', name: 'read_file', content: { request_id: 'read-456' }, attachments: [3] },
  ], new Map([[3, file]]))
  expect(message.content).not.toContainEqual(expect.objectContaining({ type: 'file' }))
  expect(JSON.stringify(message)).toContain('/uploads/3.mp3')
  expect(JSON.stringify(message)).toContain('analyze_file')
})

it('keeps attachment paths out of the tool receipt but available for replay', async () => {
  const { toolResultPart } = await import('@/shared/parts')
  const result = toolResultPart('r', 'read_file', { request_id: 'id', __attachments: [9], __attachment_paths: { 9: '/artifacts/42.pdf' } })
  expect(result.content).toEqual({ request_id: 'id' })
  const message = toolImagesMessage([result], new Map([[9, { mime: 'application/pdf', unavailable: 'Cannot read PDF', data: { type: 'data', data: new Uint8Array() } }]]))
  expect(JSON.stringify(message)).toContain('/artifacts/42.pdf')
  expect(JSON.stringify(message)).not.toContain('/uploads/9.pdf')
})

it('requires both the model modality and the protocol format support', async () => {
  const { canReadFile } = await import('@/shared/file-media')
  const model = { modalities: { input: ['text', 'image', 'pdf', 'audio', 'video'] as const, output: ['text'] as const } }
  const metadata = { modalities: { input: [...model.modalities.input], output: [...model.modalities.output] } }
  expect(canReadFile(metadata, 'anthropic', 'application/pdf')).toBe(true)
  expect(canReadFile(metadata, 'anthropic', 'audio/mpeg')).toBe(false)
  expect(canReadFile(metadata, 'responses', 'audio/mpeg')).toBe(false)
  expect(canReadFile(metadata, 'responses', 'video/mp4')).toBe(false)
  expect(canReadFile(metadata, 'chat-completions', 'audio/ogg')).toBe(false)
  expect(canReadFile(metadata, 'chat-completions', 'audio/wav')).toBe(true)
  expect(canReadFile(metadata, 'vertex-compatible', 'video/mp4')).toBe(true)
  expect(canReadFile({ modalities: { input: ['text', 'image'], output: ['text'] } }, 'responses', 'application/pdf')).toBe(false)
})


it('rejects AAC ADTS bytes claimed as MP3', async () => {
  const { matchesFileSignature } = await import('@/shared/file-media')
  expect(matchesFileSignature('audio/mpeg', new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe(false)
  expect(matchesFileSignature('audio/mpeg', new Uint8Array([0xff, 0xfb, 0x90, 0x64]))).toBe(true)
})

it('finishes outstanding tool results before injecting files during replay', async () => {
  const { buildModelMessages } = await import('@/server/plugins/llm/messages')
  const output = buildModelMessages({
    protocol: 'responses', systemPrompt: null,
    attachments: new Map([[12, { mime: 'application/pdf', data: { type: 'data', data: new TextEncoder().encode('%PDF-1.7') } }]]),
    path: [{ id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, parts: [
      { type: 'tool_call', id: 'a', name: 'read_file', args: {} },
      { type: 'tool_call', id: 'b', name: 'read_file', args: {} },
      { type: 'tool_result', call_id: 'a', name: 'read_file', content: { request_id: 'ra' }, attachments: [12] },
      { type: 'tool_call', id: 'c', name: 'read_file', args: {} },
      { type: 'tool_result', call_id: 'b', name: 'read_file', content: { request_id: 'rb' }, attachments: [12] },
      { type: 'tool_result', call_id: 'c', name: 'read_file', content: { request_id: 'rc' }, attachments: [12] },
    ] }],
  })
  expect(output.map(message => message.role)).toEqual(['assistant', 'tool', 'user', 'user', 'user'])
  expect(output[0]!.content).toHaveLength(3)
  expect(output[1]!.content).toHaveLength(3)
})

it('allows repairing an invalid saved prompt but refuses new blank prompts', async () => {
  const { UserSettingsSchema } = await import('@/shared/models')
  const { SettingsUpdateCommandSchema } = await import('@/shared/ws')
  expect(UserSettingsSchema.safeParse({ service_prompts: { file_understanding: '' } }).success).toBe(true)
  expect(SettingsUpdateCommandSchema.safeParse({ type: 'settings.update', settings: { service_prompts: { file_understanding: '   ' } } }).success).toBe(false)
})
