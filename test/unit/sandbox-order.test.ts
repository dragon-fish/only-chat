import { describe, expect, it } from 'vitest'
import { inCallOrder } from '@/plugins/sandbox/server/order'

function runtime() {
  return { turn: new Map<string, unknown>(), signal: new AbortController().signal }
}

describe('inCallOrder', () => {
  it('runs calls of one turn one after another, in call order', async () => {
    const turn = runtime()
    const log: string[] = []
    const slow = inCallOrder(turn, async (name: string, _options: unknown) => {
      log.push(`${name} start`)
      await new Promise(resolve => setTimeout(resolve, name === 'first' ? 20 : 0))
      log.push(`${name} end`)
      return name
    })
    const results = await Promise.all([slow('first', {}), slow('second', {})])
    expect(results).toEqual(['first', 'second'])
    expect(log).toEqual(['first start', 'first end', 'second start', 'second end'])
  })

  it('keeps going after a call fails', async () => {
    const turn = runtime()
    const failing = inCallOrder(turn, async (fail: boolean, _options: unknown) => {
      if (fail) throw new Error('boom')
      return 'ok'
    })
    const first = failing(true, {})
    const second = failing(false, {})
    await expect(first).rejects.toThrow('boom')
    expect(await second).toBe('ok')
  })

  it('never starts a queued call once the generation is stopped', async () => {
    const controller = new AbortController()
    const turn = { turn: new Map<string, unknown>(), signal: controller.signal }
    let ran = 0
    const call = inCallOrder(turn, async (_input: null, _options: unknown) => {
      ran++
      controller.abort()
      return 'done'
    })
    const results = await Promise.all([call(null, {}), call(null, {})])
    expect(ran).toBe(1)
    expect(results[1]).toMatchObject({ error: expect.stringContaining('stopped') })
  })
})
