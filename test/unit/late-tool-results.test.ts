import { describe, expect, it, vi } from 'vitest'
import { keepLateResults } from '@/server/plugins/hub/generation'
import type { ToolSet } from 'ai'

function toolset(run: () => Promise<unknown>): ToolSet {
  return { search: { inputSchema: undefined, execute: run } as never }
}

describe('keepLateResults', () => {
  it('records a result that arrives after the stream stopped being read', async () => {
    // A search over the network is away and billed the moment it leaves; dropping what it returns
    // means paying for it twice to get it again.
    const record = vi.fn(async () => {})
    let live = true
    const tools = keepLateResults(toolset(async () => ({ hits: 3 })), () => live, record)
    live = false
    const out = await (tools.search!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      {}, { toolCallId: 'c1' },
    )
    expect(out).toEqual({ hits: 3 })
    expect(record).toHaveBeenCalledWith('search', 'c1', { hits: 3 })
  })

  it('stands aside while the stream is still being read', async () => {
    const record = vi.fn(async () => {})
    const tools = keepLateResults(toolset(async () => 'ok'), () => true, record)
    await (tools.search!.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, { toolCallId: 'c1' })
    expect(record).not.toHaveBeenCalled()
  })

  it('leaves a tool with nothing to execute exactly as it was', async () => {
    // ask_user has no execute; wrapping one would invent a result for a question nobody answered.
    const human = { search: { inputSchema: undefined } as never }
    expect(keepLateResults(human, () => false, vi.fn()).search).toBe(human.search)
  })
})
