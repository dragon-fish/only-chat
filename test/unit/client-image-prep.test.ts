import { describe, expect, it } from 'vitest'
import { sha256Hex } from '@/client/lib/image-prep'

describe('sha256Hex', () => {
  it('hashes bytes to lowercase hex', async () => {
    expect(await sha256Hex(new Uint8Array([1, 2, 3, 4]).buffer)).toBe('9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a')
  })
})

it('does not resize JPEGs into a format disabled by the upload policy', async () => {
  const { vi } = await import('vitest')
  const { prepareImage } = await import('@/client/lib/image-prep')
  vi.stubGlobal('createImageBitmap', async () => ({ width: 4096, height: 2048, close() {} }))
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (callback: (blob: Blob) => void, type: string) => callback(new Blob(['encoded'], { type })) }) })
  try {
    const result = await prepareImage(new Blob(['jpeg'], { type: 'image/jpeg' }), ['image/jpeg'])
    expect(result.blob.type).toBe('image/jpeg')
    expect(result.width).toBe(2048)
  } finally { vi.unstubAllGlobals() }
})
