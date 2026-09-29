import { describe, expect, it } from 'vitest'
import { withDownloadName } from '@/client/lib/api'

describe('withDownloadName', () => {
  it('names the file on our own routes and leaves a blob: URL resolvable', () => {
    expect(withDownloadName('/api/attachments/105', 'cars (1).csv')).toBe('/api/attachments/105?download=cars%20(1).csv')
    expect(withDownloadName('/api/x?variant=preview', 'a.png')).toBe('/api/x?variant=preview&download=a.png')
    expect(withDownloadName('blob:http://localhost/abc', 'a.png')).toBe('blob:http://localhost/abc')
  })
})
