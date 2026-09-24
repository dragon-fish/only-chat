import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { buildModelMessages, type AttachmentInput } from '@/server/plugins/llm/messages'
import type { Message } from '@/shared/models'

const png: AttachmentInput = { mime: 'image/png', data: { type: 'data', data: new Uint8Array([137, 80, 78, 71]) } }

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return { conversation_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over }
}

describe('images returned by a tool, as Anthropic receives them', () => {
  it('share one user turn with the tool results, results first, so roles still alternate', async () => {
    let body: { messages: Array<{ role: string, content: Array<{ type: string }> }> } | undefined
    const anthropic = createAnthropic({
      apiKey: 'test',
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body))
        return Response.json({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    })
    const messages = buildModelMessages({
      protocol: 'anthropic', systemPrompt: null, attachments: new Map([[9, png]]),
      path: [
        msg({ id: 1, role: 'user', parts: [{ type: 'text', text: 'look' }] }),
        msg({ id: 2, role: 'assistant', parts: [
          { type: 'tool_call', id: 'call_r', name: 'read_file', args: { path: '/artifacts/33.png' } },
          { type: 'tool_result', call_id: 'call_r', name: 'read_file', content: { path: '/artifacts/33.png' }, attachments: [9] },
        ] }),
      ],
    })

    await generateText({ model: anthropic('claude-test'), messages })

    expect(body!.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(body!.messages[2]!.content.map(block => block.type)).toEqual(['tool_result', 'text', 'image'])
  })
})
