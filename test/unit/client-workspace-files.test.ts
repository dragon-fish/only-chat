import { describe, expect, it } from 'vitest'
import { fileTreeRows, formatFileSize } from '@/client/components/workspace-files'
import type { FileRecord } from '@/shared/workspace-files'

describe('workspace file panel', () => {
  it('keeps a size readable at every unit boundary', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    // Past ten the decimal stops earning its place.
    expect(formatFileSize(1024 * 10)).toBe('10 KB')
    expect(formatFileSize(1024 * 1023)).toBe('1023 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
  })

  it('shows the shape the model wrote, folders before files', () => {
    const rows = fileTreeRows([
      file(1, 'site/index.html'), file(2, 'notes.md'), file(3, 'site/js/app.js'), file(4, 'site/style.css'),
    ], new Set(['site', 'site/js']))
    const shown = rows.map(row => '  '.repeat(row.depth) + (row.kind === 'dir' ? row.name + '/ (' + row.count + ')' : row.name))
    expect(shown).toEqual([
      'site/ (3)',
      '  js/ (1)',
      '    app.js',
      '  index.html',
      '  style.css',
      'notes.md',
    ])
  })

  it('starts closed, hiding a folder subtree and all', () => {
    const rows = fileTreeRows([file(1, 'site/js/app.js'), file(2, 'notes.md')])
    expect(rows.map(row => row.name)).toEqual(['site', 'notes.md'])
  })
})

function file(id: number, relativePath: string): FileRecord {
  return {
    id, path: '/conversation/' + relativePath, relativePath, mount: 'conversation', projectId: null, conversationId: 1,
    fileSize: 10, totalLines: 1, mime: 'text/markdown; charset=utf-8', version: 1, updatedAt: 0, createdAt: 0,
    sourceConversationId: null, sourceMessageId: null,
  }
}
