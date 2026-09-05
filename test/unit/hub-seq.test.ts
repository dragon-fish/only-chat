import { describe, expect, it } from 'vitest'
import { SeqAllocator } from '@/server/plugins/hub/seq'

describe('SeqAllocator', () => {
  it('initialises from the db once and then counts in memory', async () => {
    let loads = 0
    const load = async () => { loads++; return 5 }
    const a = new SeqAllocator()
    expect(await a.allocate(1, load)).toBe(6)
    expect(await a.allocate(1, load)).toBe(7)
    expect(loads).toBe(1)
  })

  it('dedupes concurrent first allocations', async () => {
    let loads = 0
    const load = () => new Promise<number>((r) => setTimeout(() => { loads++; r(0) }, 5))
    const a = new SeqAllocator()
    const [x, y] = await Promise.all([a.allocate(2, load), a.allocate(2, load)])
    expect(new Set([x, y]).size).toBe(2)
    expect(loads).toBe(1)
  })
})
