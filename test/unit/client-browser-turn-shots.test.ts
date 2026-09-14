import { describe, expect, it } from 'vitest'
import { shotsInTurn } from '@/plugins/cloudflare-browser-run/client/turn-shots'
import { BROWSER_USE_TOOL_ID } from '@/shared/plugins'
import type { Part } from '@/shared/parts'

function success(shots: Array<{ attachment_id: number, name: string }>): Part {
  return {
    type: 'tool_result',
    call_id: `c${shots[0]?.attachment_id ?? 0}`,
    name: BROWSER_USE_TOOL_ID,
    content: {
      result: '', logs: '', logs_truncated: false, screenshots: shots, url: null, title: null,
    },
  }
}

describe('shotsInTurn', () => {
  it('collects every call of the turn into one strip, in order', () => {
    expect(shotsInTurn([
      success([{ attachment_id: 1, name: 'home' }]),
      { type: 'text', text: '还需要再看一页。' },
      success([{ attachment_id: 2, name: 'list' }, { attachment_id: 3, name: 'detail' }]),
    ])).toEqual([
      { attachmentId: 1, name: 'home' },
      { attachmentId: 2, name: 'list' },
      { attachmentId: 3, name: 'detail' },
    ])
  })

  it('keeps the pictures a failed call left behind', () => {
    // The error shot is often the only evidence of what the page actually looked like.
    const failed: Part = {
      type: 'tool_result',
      call_id: 'c9',
      name: BROWSER_USE_TOOL_ID,
      content: { error: 'boom', screenshots: [{ attachment_id: 9, name: 'error' }] },
    }
    expect(shotsInTurn([failed])).toEqual([{ attachmentId: 9, name: 'error' }])
  })

  it('ignores other tools and shows a repeated attachment once', () => {
    expect(shotsInTurn([
      { type: 'tool_result', call_id: 'w', name: 'write_file', content: { path: '/conversation/a.md' } },
      success([{ attachment_id: 4, name: 'once' }]),
      success([{ attachment_id: 4, name: 'again' }]),
    ])).toEqual([{ attachmentId: 4, name: 'once' }])
  })
})
