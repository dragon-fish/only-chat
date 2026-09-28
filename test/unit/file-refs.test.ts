import { describe, expect, it } from 'vitest'
import { parseFileRef, prefixUpperBound } from '@/server/plugins/file-refs/ref'
import { visibleAttachments } from '@/server/plugins/file-refs/visible'
import type { Message } from '@/shared/models'

describe('parseFileRef', () => {
  it('accepts asset: with 8 to 64 lowercase hex digits', () => {
    expect(parseFileRef('asset:3f9a2c1e')).toEqual({ ok: true, value: { scheme: 'asset', prefix: '3f9a2c1e' } })
    expect(parseFileRef(`asset:${'a'.repeat(64)}`)).toMatchObject({ ok: true })
    for (const bad of ['asset:3f9a2c1', `asset:${'a'.repeat(65)}`, 'asset:3F9A2C1E', 'asset:3f9a2c1g', 'asset:']) {
      expect(parseFileRef(bad), bad).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
    }
  })

  it('refuses a bare path and names the vfs: form instead', () => {
    const parsed = parseFileRef('/project/a.md')
    expect(parsed).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
    expect(!parsed.ok && parsed.message).toContain('vfs:/project/a.md')
  })

  it('refuses text with no scheme rather than guessing', () => {
    expect(parseFileRef('3f9a2c1e')).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
    expect(parseFileRef('cat.png')).toMatchObject({ ok: false, error: 'INVALID_FILE_REF' })
  })

  it('leaves any other scheme to the resolver, which decides whether anything claims it', () => {
    expect(parseFileRef('vfs:/project/a.md')).toEqual({ ok: true, value: { scheme: 'vfs', body: '/project/a.md' } })
    expect(parseFileRef('s3:bucket/key')).toEqual({ ok: true, value: { scheme: 's3', body: 'bucket/key' } })
  })
})

describe('prefixUpperBound', () => {
  it('is the first string past every digest that starts with the prefix', () => {
    expect(prefixUpperBound('3f9a2c1e')).toBe('3f9a2c1f')
    expect(prefixUpperBound('3f9a2c1f')).toBe('3f9a2c2')
    expect(prefixUpperBound('3fffffff')).toBe('4')
    expect(prefixUpperBound('ffffffff')).toBeNull()
  })
})

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return { conversation_id: 1, parent_id: null, seq: over.id, provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0, ...over }
}

describe('visibleAttachments', () => {
  it('collects exactly the sources the model was shown, with the filename a part names', () => {
    const found = visibleAttachments([
      msg({ id: 1, role: 'user', parts: [
        { type: 'image', attachment_id: 1, filename: 'cat.png' },
        { type: 'file', attachment_id: 2, mime: 'application/pdf' },
        { type: 'task_notification', task_id: 't', plugin_id: 'p', tool_call_id: 'c', status: 'completed', text: '', attachments: [3] },
      ] }),
      msg({ id: 2, role: 'assistant', parts: [
        { type: 'image', attachment_id: 4 },
        { type: 'tool_result', call_id: 'c', name: 'read_file', content: { attachment_id: 99 }, attachments: [5] },
        { type: 'text', text: 'asset:deadbeef' },
      ] }),
    ])
    expect(found).toEqual(new Map([[1, 'cat.png'], [2, null], [3, null], [4, null], [5, null]]))
  })
})
