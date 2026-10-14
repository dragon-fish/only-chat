import { describe, expect, it } from 'vitest'
import { STALLED, nextBefore } from '@/plugins/sandbox/server/stall'

describe('nextBefore', () => {
  it('gives up on a stream that never yields once the deadline passes', async () => {
    const silent: AsyncIterator<number> = { next: () => new Promise(() => {}) }
    expect(await nextBefore(silent, Date.now() + 20)).toBe(STALLED)
  })

  it('passes through what arrives in time', async () => {
    async function* one() { yield 1 }
    expect(await nextBefore(one(), Date.now() + 1_000)).toEqual({ value: 1, done: false })
  })
})
