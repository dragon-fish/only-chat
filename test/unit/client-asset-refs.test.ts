import { describe, expect, it } from 'vitest'
import { assetRefOf, createAssetResolver } from '@/client/lib/asset-refs'
import type { ConversationAsset } from '@/shared/conversation-assets'

const asset = (ref: string, attachmentId: number): ConversationAsset => ({
  attachmentId, ref, source: 'generated', mime: 'image/png', size: 1, width: 1, height: 1, filename: null, createdAt: 0,
})

describe('assetRefOf', () => {
  it('reads the prefix of an asset URL and nothing else', () => {
    expect(assetRefOf('asset:F0AB4837')).toBe('f0ab4837')
    expect(assetRefOf('https://example.com/a.png')).toBeNull()
    expect(assetRefOf('asset:f0ab')).toBeNull()
  })
})

describe('createAssetResolver', () => {
  it('fetches again when a reference is not in the list it has, since the image may be new', async () => {
    const lists = [[asset('aaaaaaaa', 1)], [asset('aaaaaaaa', 1), asset('bbbbbbbb', 2)]]
    let calls = 0
    const resolve = createAssetResolver(async () => ({ assets: lists[Math.min(calls++, 1)]! }))
    expect((await resolve(7, 'aaaaaaaa'))?.attachmentId).toBe(1)
    expect((await resolve(7, 'bbbbbbbb'))?.attachmentId).toBe(2)
    expect((await resolve(7, 'aaaaaaaa'))?.attachmentId).toBe(1)
    expect(calls).toBe(2)
  })

  it('shares one fetch between references that miss together', async () => {
    let calls = 0
    const resolve = createAssetResolver(async () => { calls++; return { assets: [asset('aaaaaaaa', 1), asset('bbbbbbbb', 2)] } })
    const found = await Promise.all([resolve(7, 'aaaaaaaa'), resolve(7, 'bbbbbbbb')])
    expect(found.map(item => item?.attachmentId)).toEqual([1, 2])
    expect(calls).toBe(1)
  })

  it('does not keep a failed fetch, so a later image can try again', async () => {
    let calls = 0
    const resolve = createAssetResolver(async () => {
      if (calls++ === 0) throw new Error('offline')
      return { assets: [asset('aaaaaaaa', 1)] }
    })
    await expect(resolve(7, 'aaaaaaaa')).rejects.toThrow('offline')
    expect((await resolve(7, 'aaaaaaaa'))?.attachmentId).toBe(1)
  })
})
