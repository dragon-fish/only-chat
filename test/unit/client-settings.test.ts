import { describe, expect, it, vi } from 'vitest'
import { isChatHistoryRoute, createModelWriteQueue, acknowledgedPlugins } from '@/client/lib/settings'
import type { ModelWithMetadata } from '@/shared/models'
import { modelRecords } from './provider-fixtures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const model = modelRecords[0]!

describe('settings navigation and model editing', () => {
  it('acknowledges only plugin switches matching the authoritative server values', () => {
    // One settings.updated may acknowledge one of several toggles; an unrelated broadcast must
    // not clear the other pending switch or falsely announce success.
    const pending = new Map([['search', true], ['tools', false]])
    expect(acknowledgedPlugins(pending, { search: false, tools: true })).toEqual([])
    expect(acknowledgedPlugins(pending, { search: true, tools: true })).toEqual(['search'])
    expect(acknowledgedPlugins(pending, { search: true, tools: false })).toEqual(['search', 'tools'])
    expect(acknowledgedPlugins(pending, {})).toEqual([])
  })
  it('only returns through history for chat routes, including their query strings', () => {
    // A settings or external history entry must never be treated as the chat return destination.
    for (const path of ['/new', '/chats', '/projects', '/c/12?foo=bar', '/project/7', '/project/7/new', '/project/7/c/8']) expect(isChatHistoryRoute(path)).toBe(true)
    for (const path of [null, '/settings', '/projects/3', '/project/7/settings', '/c/12/edit', 'https://example.com/c/12']) expect(isChatHistoryRoute(path)).toBe(false)
  })

  it('serializes rapid model writes and only publishes the newest result', async () => {
    // Concurrent writes can reach the server out of order and erase the user's later intent.
    const firstWrite = deferred<void>()
    const write = vi.fn().mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(undefined)
    const apply = vi.fn()
    const read = vi.fn().mockResolvedValue([{ ...model, enabled: false }])
    const queue = createModelWriteQueue({ write, read, apply, onError: vi.fn() })
    const first = queue(2, { metadata_override: { reasoning: true } })
    const second = queue(2, { enabled: false })
    await Promise.resolve()
    expect(write.mock.calls).toEqual([[2, { metadata_override: { reasoning: true } }]])
    firstWrite.resolve()
    await Promise.all([first, second])
    expect(write.mock.calls).toEqual([[2, { metadata_override: { reasoning: true } }], [2, { enabled: false }]])
    expect(read).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledExactlyOnceWith([{ ...model, enabled: false }])
  })

  it('discards a reread when another edit arrived while it was in flight', async () => {
    // A sequence check only before the read would repaint the row with stale state.
    const staleRead = deferred<ModelWithMetadata[]>()
    const readStarted = deferred<void>()
    const apply = vi.fn()
    const read = vi.fn().mockImplementationOnce(() => { readStarted.resolve(); return staleRead.promise }).mockResolvedValue([{ ...model, enabled: false }])
    const queue = createModelWriteQueue({ write: async () => {}, read, apply, onError: vi.fn() })
    const first = queue(2, { enabled: true })
    await readStarted.promise
    const second = queue(2, { enabled: false })
    staleRead.resolve([model])
    await Promise.all([first, second])
    expect(apply).toHaveBeenCalledExactlyOnceWith([{ ...model, enabled: false }])
  })

  it('reconciles failed optimistic writes and keeps accepting later edits', async () => {
    // A rejected chain must not leave the optimistic row lying or poison subsequent writes.
    const error = new Error('offline')
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
    const onError = vi.fn()
    const apply = vi.fn()
    const queue = createModelWriteQueue({ write, read: async () => [model], apply, onError })
    expect(await queue(2, { enabled: false })).toBe(false)
    expect(onError).toHaveBeenCalledWith(error)
    expect(apply).toHaveBeenCalledWith([model])
    expect(await queue(2, { enabled: true })).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
  })
})
