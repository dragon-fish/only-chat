import { describe, expect, it, vi } from 'vitest'
import { runWebExtract, runWebSearch } from '@/plugins/tavily/server/runners'
import type { WebExtractClient, WebSearchClient } from '@/plugins/tavily/shared'

const searchClient = (results: { title: string; url: string; content: string }[] = []): WebSearchClient => ({
  search: vi.fn(async () => results),
})

const extractClient = (): WebExtractClient => ({
  extract: vi.fn(async (urls: string[]) => ({
    results: urls.map(url => ({ url, content: `body of ${url}` })),
    failed: [],
  })),
})

describe('tavily runners', () => {
  it('refuses further calls once the per-turn cap is reached, without touching the client', async () => {
    const turn = new Map<string, unknown>()
    const client = searchClient([{ title: 'T', url: 'https://a.test', content: 'c' }])
    expect(await runWebSearch({ query: 'q' }, client, turn, 2)).toMatchObject({ query: 'q' })
    expect(await runWebSearch({ query: 'q' }, client, turn, 2)).toMatchObject({ query: 'q' })

    const refusal = await runWebSearch({ query: 'q' }, client, turn, 2)
    expect(refusal).toEqual({ refused: 'web_search 调用次数耗尽（0/2），额度在用户下次发言后重置。' })
    expect(client.search).toHaveBeenCalledTimes(2)
  })

  it('reports the budget as left/cap, and says so the moment the last call spends it', async () => {
    const turn = new Map<string, unknown>()
    const client = searchClient()
    expect(await runWebSearch({ query: 'q' }, client, turn, 3)).toMatchObject({ note: 'web_search 剩余 2/3 次。' })
    expect(await runWebSearch({ query: 'q' }, client, turn, 3)).toMatchObject({ note: 'web_search 剩余 1/3 次。' })
    // The call that spends the last of the budget still returns its results, and says so without
    // the vocabulary of failure — 「耗尽」 is reserved for a call that was actually turned away.
    const last = await runWebSearch({ query: 'q' }, searchClient([{ title: 'T', url: 'https://a.test', content: 'c' }]), new Map([['tavily.search.calls', 2]]), 3)
    expect(last).toMatchObject({
      query: 'q',
      results: [{ url: 'https://a.test' }],
      note: 'web_search 剩余 0/3 次，额度在用户下次发言后重置。',
    })

    const extract = extractClient()
    expect(await runWebExtract({ urls: ['https://a.test'] }, extract, turn, 2))
      .toMatchObject({ note: 'web_extract 剩余 1/2 次。' })
  })

  it('budgets search and extract separately', async () => {
    const turn = new Map<string, unknown>()
    const search = searchClient()
    const extract = extractClient()
    await runWebSearch({ query: 'q' }, search, turn, 1)
    expect(await runWebSearch({ query: 'q' }, search, turn, 1)).toMatchObject({ refused: expect.any(String) })
    expect(await runWebExtract({ urls: ['https://a.test'] }, extract, turn, 1)).toMatchObject({
      results: [{ url: 'https://a.test' }],
    })
  })

  it('turns a client failure into a result the model can read, not a thrown error', async () => {
    const turn = new Map<string, unknown>()
    const failing: WebSearchClient = { search: vi.fn(async () => { throw new Error('network down') }) }
    expect(await runWebSearch({ query: 'q' }, failing, turn, 3)).toEqual({ error: 'web_search 失败：network down' })
  })

  it('a failed call still consumes its budget', async () => {
    const turn = new Map<string, unknown>()
    const failing: WebSearchClient = { search: vi.fn(async () => { throw new Error('boom') }) }
    await runWebSearch({ query: 'q' }, failing, turn, 1)
    expect(await runWebSearch({ query: 'q' }, failing, turn, 1)).toEqual({
      refused: 'web_search 调用次数耗尽（0/1），额度在用户下次发言后重置。',
    })
    expect(failing.search).toHaveBeenCalledTimes(1)
  })

  it('clamps max_results to the documented range and defaults when absent', async () => {
    const turn = new Map<string, unknown>()
    const client = searchClient()
    await runWebSearch({ query: 'q' }, client, turn, 5)
    await runWebSearch({ query: 'q', max_results: 99 }, client, turn, 5)
    await runWebSearch({ query: 'q', max_results: 2 }, client, turn, 5)
    expect((client.search as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.maxResults))
      .toEqual([5, 10, 2])
  })

  it('passes extraction failures through instead of discarding the whole batch', async () => {
    const turn = new Map<string, unknown>()
    const client: WebExtractClient = {
      extract: vi.fn(async () => ({
        results: [{ url: 'https://ok.test', content: 'body' }],
        failed: [{ url: 'https://bad.test', error: 'timeout' }],
      })),
    }
    expect(await runWebExtract({ urls: ['https://ok.test', 'https://bad.test'] }, client, turn, 2)).toEqual({
      results: [{ url: 'https://ok.test', content: 'body' }],
      failed: [{ url: 'https://bad.test', error: 'timeout' }],
      note: 'web_extract 剩余 1/2 次。',
    })
  })
})
