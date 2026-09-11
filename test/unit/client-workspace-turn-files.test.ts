import { describe, expect, it } from 'vitest'
import type { Part } from '@/shared/parts'
import { filesWrittenInTurn } from '@/plugins/workspace-files/client/turn-files'

function result(name: string, content: unknown): Part {
  return { type: 'tool_result', call_id: `c${Math.random()}`, name, content }
}
function write(path: string, version: number, operation = 'updated') {
  return result('write_file', {
    path, operation, version, fileSize: version * 10, totalLines: version,
    replacedVersion: null, staleReadVersion: null, message: 'ok',
  })
}

describe('files a turn produced', () => {
  it('reports one row per file, carrying the last write of that turn', () => {
    const files = filesWrittenInTurn([
      { type: 'text', text: 'hi' } as Part,
      write('/project/a.md', 1, 'created'),
      write('/conversation/b.md', 4),
      write('/project/a.md', 2),
    ])
    // Order follows the first write: the reader watched them appear in that order.
    expect(files).toEqual([
      { path: '/project/a.md', version: 2, fileSize: 20, totalLines: 2, created: true },
      { path: '/conversation/b.md', version: 4, fileSize: 40, totalLines: 4, created: false },
    ])
  })

  it('counts a restored file and ignores a call that failed', () => {
    const files = filesWrittenInTurn([
      result('write_file', { error: 'VERSION_CONFLICT', message: 'moved' }),
      result('restore_file', {
        path: '/project/a-v3.md', sourcePath: '/project/a.md', restoredFrom: 3,
        version: 1, fileSize: 30, totalLines: 3, message: 'ok',
      }),
      result('read_file', { path: '/project/a.md', content: 'x' }),
    ])
    expect(files).toEqual([
      { path: '/project/a-v3.md', version: 1, fileSize: 30, totalLines: 3, created: true },
    ])
  })
})
