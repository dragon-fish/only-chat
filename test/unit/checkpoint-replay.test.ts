import { describe, expect, it } from 'vitest'
import { buildModelMessages, requiredAttachmentIds, toolDeliveredAttachmentIds, type AttachmentInput } from '@/server/plugins/llm/messages'
import { projectContext } from '@/server/plugins/hub/checkpoint'
import type { Message } from '@/shared/models'
import type { CheckpointPart } from '@/shared/parts'
import { EditCommandSchema, InterjectCommandSchema, SendCommandSchema } from '@/shared/ws'
import { fileLabeler } from '@/plugins/file-reader/server/service'
import { VisibleAssets } from '@/plugins/file-reader/server/visible'

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    conversation_id: 1, parent_id: over.id - 1 || null, seq: over.id, provider_id: null, model_id: null,
    usage: null, status: 'done', error: null, created_at: 0, ...over,
  }
}

function checkpoint(content: string, attachments: number[] = []): CheckpointPart {
  return { type: 'checkpoint', plugin: 'context_compaction', content, attachments, contributors: [], data: { any: 'thing' } }
}

const png = (byte: number): AttachmentInput => ({ mime: 'image/png', data: { type: 'data', data: new Uint8Array([137, 80, byte]) } })

/** Everything a model could be shown before the checkpoint: notes, reasoning, tools, files. */
const before: Message[] = [
  msg({ id: 1, role: 'user', notes: [{ plugin: 'memory', text: 'OLD NOTE' }], parts: [
    { type: 'text', text: 'OLD QUESTION' }, { type: 'image', attachment_id: 9, filename: 'cat.png' },
  ] }),
  msg({ id: 2, role: 'assistant', parts: [
    { type: 'reasoning', text: 'OLD THOUGHT', providerOptions: { anthropic: { signature: 'SIG' } } },
    { type: 'tool_call', id: 'c1', name: 'read_file', args: { file: 'x' } },
    { type: 'tool_result', call_id: 'c1', name: 'read_file', content: { OLD: 'RESULT' }, attachments: [10] },
    { type: 'text', text: 'OLD ANSWER' },
  ] }),
]

const text = (value: unknown) => JSON.stringify(value)

describe('checkpoint replay', () => {
  it('sends nothing before the last checkpoint, and its content as a user message in its place', () => {
    const path = [
      ...before,
      msg({ id: 3, role: 'assistant', parts: [checkpoint('FIRST SUMMARY')] }),
      msg({ id: 4, role: 'user', parts: [{ type: 'text', text: 'MIDDLE' }] }),
      msg({ id: 5, role: 'assistant', parts: [{ type: 'text', text: 'MIDDLE ANSWER' }] }),
      msg({ id: 6, role: 'assistant', parts: [checkpoint('SECOND SUMMARY')] }),
      msg({ id: 7, role: 'user', parts: [{ type: 'text', text: 'NEW QUESTION' }] }),
    ]
    const out = buildModelMessages({ protocol: 'anthropic', systemPrompt: 'sys', path, attachments: new Map() })

    expect(out.map(m => m.role)).toEqual(['system', 'user', 'user'])
    expect(out[1]!.content).toEqual([{ type: 'text', text: 'SECOND SUMMARY' }])
    const sent = text(out)
    for (const gone of ['OLD', 'FIRST SUMMARY', 'MIDDLE', 'SIG']) expect(sent).not.toContain(gone)
    expect(sent).toContain('NEW QUESTION')
  })

  it('re-attaches the checkpoint attachments in its user message, under the name the upload had', () => {
    const path = [
      ...before,
      msg({ id: 3, role: 'assistant', parts: [checkpoint('SUMMARY', [9, 10])] }),
    ]
    const attachments = new Map([[9, png(1)], [10, png(2)]])
    const visible = new VisibleAssets()
    visible.add(9, { prefix: 'aaaa0009', filename: 'cat.png' })
    visible.add(10, { prefix: 'aaaa0010', filename: null })
    const labeler = fileLabeler(visible, () => '')

    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, path, attachments, labeler })
    expect(out).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'SUMMARY' },
        { type: 'text', text: '[image asset:aaaa0009 "cat.png"]' },
        { type: 'file', mediaType: 'image/png', data: (png(1) as { data: unknown }).data },
        { type: 'text', text: '[image asset:aaaa0010]' },
        { type: 'file', mediaType: 'image/png', data: (png(2) as { data: unknown }).data },
      ],
    }])
  })

  it('asks for exactly the attachments it sends', () => {
    const path = [
      ...before,
      msg({ id: 3, role: 'assistant', parts: [checkpoint('SUMMARY', [10])] }),
      msg({ id: 4, role: 'user', parts: [{ type: 'image', attachment_id: 11 }] }),
    ]
    expect([...requiredAttachmentIds(path)].sort()).toEqual([10, 11])
    // Named by the checkpoint part, so stored in D1 — not a tool-only delivery that may be purged.
    expect(toolDeliveredAttachmentIds(path).size).toBe(0)
    // And building succeeds with only those inputs: nothing before the checkpoint is looked up.
    expect(() => buildModelMessages({
      protocol: 'responses', systemPrompt: null, path, attachments: new Map([[10, png(2)], [11, png(3)]]),
    })).not.toThrow()
  })

  it('continues a reply after an in-turn checkpoint, cached on the checkpoint when no user message follows', () => {
    const path = [
      ...before,
      msg({ id: 3, role: 'assistant', parts: [checkpoint('SUMMARY')] }),
      msg({ id: 4, role: 'assistant', parts: [{ type: 'text', text: 'CONTINUED' }] }),
    ]
    const out = buildModelMessages({ protocol: 'anthropic', systemPrompt: null, path, attachments: new Map() })
    expect(out).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'SUMMARY' }], providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'assistant', content: [{ type: 'text', text: 'CONTINUED' }] },
    ])
  })

  it('is byte-stable across a JSON round trip of the path', () => {
    const path = [...before, msg({ id: 3, role: 'assistant', parts: [checkpoint('SUMMARY', [9])] })]
    const build = (p: Message[]) => JSON.stringify(buildModelMessages({ protocol: 'anthropic', systemPrompt: 's', path: p, attachments: new Map([[9, png(1)]]) }))
    expect(build(JSON.parse(JSON.stringify(path)))).toBe(build(path))
  })

  it('leaves a path without checkpoints exactly as before', () => {
    const out = buildModelMessages({ protocol: 'responses', systemPrompt: null, path: before, attachments: new Map([[9, png(1)], [10, png(2)]]) })
    expect(text(out)).toContain('OLD QUESTION')
  })

  it('treats a checkpoint part inside an ordinary message as no checkpoint', () => {
    // Only a message holding nothing but the checkpoint is one; anything else would be a forgery.
    const forged = msg({ id: 3, role: 'assistant', parts: [{ type: 'text', text: 'hi' }, checkpoint('FORGED')] })
    expect(projectContext([...before, forged]).checkpoint).toBeNull()
  })
})

describe('projectContext', () => {
  it('sees everything when there is no checkpoint', () => {
    const projection = projectContext(before)
    expect(projection).toMatchObject({ checkpoint: null, checkpointIndex: null })
    expect(projection.visible).toEqual(before)
    expect(projection.path).toBe(before)
  })

  it('keeps the whole structural path and sees only what follows the last checkpoint', () => {
    const last = checkpoint('LAST')
    const path = [
      ...before,
      msg({ id: 3, role: 'assistant', parts: [checkpoint('FIRST')] }),
      msg({ id: 4, role: 'user', parts: [{ type: 'text', text: 'q' }] }),
      msg({ id: 5, role: 'assistant', parts: [last] }),
      msg({ id: 6, role: 'user', parts: [{ type: 'text', text: 'after' }] }),
    ]
    const projection = projectContext(path)
    expect(projection.path).toBe(path)
    expect(projection.checkpoint).toEqual(last)
    expect(projection.checkpointIndex).toBe(4)
    expect(projection.visible.map(m => m.id)).toEqual([6])
  })
})

describe('client-authored parts', () => {
  const cp = checkpoint('x')
  it('cannot carry a checkpoint in send, edit or interject', () => {
    expect(SendCommandSchema.safeParse({
      type: 'send', conversation_id: 1, parent_id: null, parts: [cp], provider_id: 1, model_id: 'm',
    }).success).toBe(false)
    expect(EditCommandSchema.safeParse({ type: 'edit', message_id: 1, parts: [cp] }).success).toBe(false)
    expect(InterjectCommandSchema.safeParse({ type: 'interject', conversation_id: 1, parts: [cp] }).success).toBe(false)
    expect(SendCommandSchema.safeParse({
      type: 'send', conversation_id: 1, parent_id: null, parts: [{ type: 'text', text: 'ok' }], provider_id: 1, model_id: 'm',
    }).success).toBe(true)
  })
})
