import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const warning = vi.fn()
vi.mock('vue-sonner', () => ({ toast: { warning } }))

async function load(clientBuild: string) {
  vi.stubEnv('BUILD_VERSION', clientBuild)
  vi.resetModules()
  return await import('@/client/lib/build-version')
}

beforeEach(() => warning.mockClear())
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('noticeServerBuild', () => {
  it('prompts once when the Worker was built from another commit', async () => {
    const { noticeServerBuild } = await load('aaa')
    noticeServerBuild('bbb')
    noticeServerBuild('ccc')
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on the same build, and whenever either side is a dev build', async () => {
    const { noticeServerBuild } = await load('aaa')
    noticeServerBuild('aaa')
    noticeServerBuild('dev')
    noticeServerBuild(undefined)
    expect(warning).not.toHaveBeenCalled()
    const dev = await load('dev')
    dev.noticeServerBuild('bbb')
    expect(warning).not.toHaveBeenCalled()
  })

  it('announces a failed chunk as an update only when the server confirms a newer build', async () => {
    const { verifyAfterChunkFailure } = await load('aaa')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down') }))
    await verifyAfterChunkFailure()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'x-only-chat-build': 'aaa' } })))
    await verifyAfterChunkFailure()
    expect(warning).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'x-only-chat-build': 'bbb' } })))
    await verifyAfterChunkFailure()
    expect(warning).toHaveBeenCalledTimes(1)
  })
})
