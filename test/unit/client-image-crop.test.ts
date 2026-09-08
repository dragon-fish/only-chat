import { describe, expect, it } from 'vitest'
import { initialCrop, moveCrop, resizeCrop } from '@/client/lib/image-crop'

describe('image crop geometry', () => {
  it('centers the largest crop with the requested aspect ratio', () => {
    expect(initialCrop(400, 300, 1)).toEqual({ x: 50, y: 0, width: 300, height: 300 })
  })

  it('clamps moves and proportional corner resizes to image bounds', () => {
    const crop = { x: 50, y: 50, width: 100, height: 100 }
    expect(moveCrop(crop, -100, 300, 300, 200)).toEqual({ x: 0, y: 100, width: 100, height: 100 })
    expect(resizeCrop(crop, 'se', 200, 50, 300, 200, 1, 32)).toEqual({ x: 50, y: 50, width: 150, height: 150 })
  })
})
