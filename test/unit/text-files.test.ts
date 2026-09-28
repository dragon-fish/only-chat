import { describe, expect, it } from 'vitest'
import { buildModelMessages, type AttachmentInput } from '@/server/plugins/llm/messages'
import { fileLabeler, INLINE_TEXT_BYTES } from '@/plugins/file-reader/server/service'
import { VisibleAssets } from '@/plugins/file-reader/server/visible'
import { isUtf8Text, matchesFileSignature, textMimeFromFilename, uploadAccept } from '@/shared/file-media'
import type { Message } from '@/shared/models'

describe('text uploads', () => {
  it('are typed by extension, whatever the browser declared', () => {
    expect(textMimeFromFilename('main.ts')).toBe('text/plain')
    expect(textMimeFromFilename('Page.HTML')).toBe('text/html')
    expect(textMimeFromFilename('data.csv')).toBe('text/csv')
    expect(textMimeFromFilename('photo.png')).toBeUndefined()
    expect(textMimeFromFilename('Makefile')).toBeUndefined()
  })

  it('accept UTF-8 only, with or without a BOM, and nothing holding a NUL', () => {
    const utf8 = new TextEncoder().encode('你好，world')
    expect(isUtf8Text(utf8)).toBe(true)
    expect(isUtf8Text(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe(true)
    // "你好" in GBK: not valid UTF-8, and refused rather than guessed at.
    expect(isUtf8Text(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe(false)
    expect(isUtf8Text(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false)
    expect(matchesFileSignature('text/html', new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBe(false)
  })

  it('let a file picker show source files the OS has no text type for', () => {
    const accept = uploadAccept(['text/plain', 'image/png']).split(',')
    expect(accept).toEqual(expect.arrayContaining(['text/plain', 'image/png', '.py', '.ts', '.vue']))
    expect(accept).not.toContain('.html')
  })
})

describe('a text attachment in the prompt', () => {
  const path: Message[] = [{
    id: 1, conversation_id: 1, parent_id: null, seq: 1, role: 'user', provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0,
    parts: [{ type: 'file', attachment_id: 5, mime: 'text/html', filename: 'page.html' }, { type: 'text', text: 'fix the title' }],
  }]
  const build = (text: string, labelled: boolean) => {
    const attachments = new Map<number, AttachmentInput>([[5, { mime: 'text/html', text }]])
    const visible = new VisibleAssets()
    visible.add(5, { prefix: '3f9a2c1e', filename: 'page.html' })
    const labeler = labelled ? fileLabeler(visible, () => '') : undefined
    return buildModelMessages({ protocol: 'responses', systemPrompt: null, path, attachments, labeler })[0]!.content
  }

  it('is inlined whole, as if pasted, when nothing names files', () => {
    const large = 'x'.repeat(INLINE_TEXT_BYTES * 2)
    expect(build(large, false)).toEqual([
      { type: 'text', text: `<file name="page.html">\n${large}\n</file>` },
      { type: 'text', text: 'fix the title' },
    ])
  })

  it('is inlined with its reference up to the limit, and only named past it, when the file reader is on', () => {
    expect(build('<title>a</title>', true)).toEqual([
      { type: 'text', text: '<file asset="3f9a2c1e" name="page.html">\n<title>a</title>\n</file>' },
      { type: 'text', text: 'fix the title' },
    ])
    const large = `${'x'.repeat(INLINE_TEXT_BYTES)}\nlast`
    expect(build(large, true)).toEqual([
      { type: 'text', text: '[file asset:3f9a2c1e "page.html" text/html, 2 lines — read it with read_file]' },
      { type: 'text', text: 'fix the title' },
    ])
  })
})
