import { describe, expect, it } from 'vitest'
import { formatFileSize } from '@/client/components/workspace-files'

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
})
