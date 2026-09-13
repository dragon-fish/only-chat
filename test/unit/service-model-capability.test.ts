import { describe, expect, it } from 'vitest'
import { canServeAsServiceModel } from '@/shared/service-model'

const modalities = (input: string[], output: string[]) =>
  ({ modalities: { input, output } }) as Parameters<typeof canServeAsServiceModel>[0]

describe('a service model has to be able to read and write text', () => {
  it('accepts an ordinary text model', () => {
    expect(canServeAsServiceModel(modalities(['text'], ['text']))).toBe(true)
    expect(canServeAsServiceModel(modalities(['text', 'image'], ['text']))).toBe(true)
  })

  it('rejects a model that draws instead of answering', () => {
    // Naming a conversation with an image generator produces an image, not a name.
    expect(canServeAsServiceModel(modalities(['text'], ['image']))).toBe(false)
    expect(canServeAsServiceModel(modalities(['text'], ['video']))).toBe(false)
  })

  it('rejects a model that cannot be given text to read', () => {
    expect(canServeAsServiceModel(modalities(['image'], ['text']))).toBe(false)
  })

  it('rejects a model that never said what it handles', () => {
    expect(canServeAsServiceModel({})).toBe(false)
  })
})
