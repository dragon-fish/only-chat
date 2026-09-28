import { describe, expect, it } from 'vitest'
import { PartSchema } from '@/shared/parts'

describe('file attachments', () => {
  it('preserves a non-image attachment through message validation', () => {
    const part = { type: 'file', attachment_id: 12, mime: 'audio/mpeg', filename: 'recording.mp3' }
    expect(PartSchema.safeParse(part).success).toBe(true)
    expect(PartSchema.parse(part)).toEqual(part)
  })
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
    assets: new Map([[12, 'b41d07a9']]),
    path: [{ id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'assistant', provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, parts: [
      { type: 'tool_call', id: 'a', name: 'read_file', args: {} },
      { type: 'tool_call', id: 'b', name: 'read_file', args: {} },
      { type: 'tool_result', call_id: 'a', name: 'read_file', content: {}, attachments: [12] },
      { type: 'tool_call', id: 'c', name: 'read_file', args: {} },
      { type: 'tool_result', call_id: 'b', name: 'read_file', content: {}, attachments: [12] },
      { type: 'tool_result', call_id: 'c', name: 'read_file', content: {}, attachments: [12] },
    ] }],
  })
  expect(output.map(message => message.role)).toEqual(['assistant', 'tool', 'user'])
  expect(output[0]!.content).toHaveLength(3)
  expect(output[1]!.content).toHaveLength(3)
  expect((output[2]!.content as Array<{ text?: string }>).filter(part => part.text?.startsWith('<tool_attachment')).map(part => part.text))
    .toEqual(['a', 'b', 'c'].map(id => `<tool_attachment call_id="${id}" asset="b41d07a9">`))
})

it('allows repairing an invalid saved prompt but refuses new blank prompts', async () => {
  const { UserSettingsSchema } = await import('@/shared/models')
  const { SettingsUpdateCommandSchema } = await import('@/shared/ws')
  expect(UserSettingsSchema.safeParse({ service_prompts: { file_understanding: '' } }).success).toBe(true)
  expect(SettingsUpdateCommandSchema.safeParse({ type: 'settings.update', settings: { service_prompts: { file_understanding: '   ' } } }).success).toBe(false)
})
