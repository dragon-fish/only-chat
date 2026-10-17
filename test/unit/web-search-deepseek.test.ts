import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekClient, unescapeMarkdown } from '@/plugins/web-search/server/deepseek'

interface Sent { url: string; headers: Headers; body: Record<string, unknown> }

/** Answers each request with the next responder's reply and records what was sent. */
function stubFetch(respond: (sent: Sent) => Response): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const request = { url: input, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> }
    sent.push(request)
    return respond(request)
  }))
  return sent
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('unescapeMarkdown', () => {
  it('undoes the punctuation escapes fetch adds, and only those', () => {
    expect(unescapeMarkdown('\\#\\# https\\:\\/\\/api\\.deepseek\\.com\\/v1')).toBe('## https://api.deepseek.com/v1')
    expect(unescapeMarkdown('a \\\\ b')).toBe('a \\ b')
    expect(unescapeMarkdown('C:\\Users and \\n stay')).toBe('C:\\Users and \\n stay')
  })
})

describe('DeepSeekClient.search', () => {
  it('keeps every field DeepSeek reports, with the summary as the excerpt', async () => {
    const sent = stubFetch(() => json({
      results: [
        {
          title: 'Search & Fetch', url: 'https://api-docs.deepseek.com/guides/search/', snippet: 'short', summary: 'long passages',
          content: '\\# Title', site_name: 'DeepSeek', site_icon: 'https://cdn.deepseek.com/site-icons/deepseek.com',
          date: '2026-10-16T00:00:00+00:00', authority: 3, rerank_score: 2.26,
        },
        { title: 'Bare', url: 'https://bare.test', snippet: 'only a snippet' },
      ],
    }))
    const client = new DeepSeekClient({ apiKey: 'sk-test', headers: { 'X-Extra': 'kept' } })

    const results = await client.search({ query: 'deepseek search', question: 'when did it launch?', full_text: true })

    expect(results).toEqual([
      {
        title: 'Search & Fetch', url: 'https://api-docs.deepseek.com/guides/search/', content: 'long passages', score: 2.26,
        date: '2026-10-16T00:00:00+00:00', site_name: 'DeepSeek', site_icon: 'https://cdn.deepseek.com/site-icons/deepseek.com',
        authority: 3, full_text: '# Title',
      },
      { title: 'Bare', url: 'https://bare.test', content: 'only a snippet' },
    ])
    expect(sent[0]!.url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(sent[0]!.body).toEqual({ query: 'deepseek search', count: 5, ori_question: 'when did it launch?', need_content: true })
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer sk-test')
    expect(sent[0]!.headers.get('x-extra')).toBe('kept')
  })

  it('names what a failing status means without echoing the response', async () => {
    stubFetch(() => json({ error: { message: 'echo of sk-test' } }, 402))
    const failure = new DeepSeekClient({ apiKey: 'sk-test' }).search({ query: 'q' })
    await expect(failure).rejects.toThrow('account balance exhausted (HTTP 402)')
    await expect(failure).rejects.not.toThrow('sk-test')
  })
})

describe('DeepSeekClient.extract', () => {
  it('fetches each URL on its own and reports failures beside successes', async () => {
    const sent = stubFetch(({ body }) => body.url === 'https://gone.test'
      ? json({ error: {} }, 404)
      : json({ title: 'Page', content: 'Hello\\, world\\.' }))

    const output = await new DeepSeekClient({ apiKey: 'sk-test' }).extract(['https://ok.test', 'https://gone.test'])

    expect(sent.map(request => request.body)).toEqual([{ url: 'https://ok.test' }, { url: 'https://gone.test' }])
    expect(output).toEqual({
      results: [{ url: 'https://ok.test', title: 'Page', content: 'Hello, world.' }],
      failed: [{ url: 'https://gone.test', error: expect.stringContaining('content unavailable') }],
    })
  })
})
