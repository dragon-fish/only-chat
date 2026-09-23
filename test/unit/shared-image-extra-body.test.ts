import { describe, expect, it } from 'vitest'
import { ImageExtraBodySchema } from '@/shared/artifacts'

describe('ImageExtraBodySchema', () => {
  it('accepts arbitrary JSON values', () => {
    expect(ImageExtraBodySchema.parse({ watermark: false, seed: 7, style: 'anime', options: { a: [1, null] } }))
      .toEqual({ watermark: false, seed: 7, style: 'anime', options: { a: [1, null] } })
  })

  it('rejects the keys the Images request always sets itself', () => {
    for (const key of ['model', 'prompt', 'n', 'image']) {
      expect(ImageExtraBodySchema.safeParse({ [key]: 'x' }).success).toBe(false)
    }
  })
})
