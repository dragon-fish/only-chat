import { describe, expect, it, vi } from 'vitest'
import { isChatHistoryRoute, modelCapabilitiesWithEfforts, createModelWriteQueue } from '@/client/lib/settings'
import type { Model } from '@/shared/models'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const model: Model = {
  id: 2, provider_id: 1, model_id: 'example', display_name: 'Example', enabled: true,
  capabilities: {}, pricing: null, sort: 0,
}

describe('settings navigation and model editing', () => {
  it('only returns through history for chat routes, including their query strings', () => {
    // A settings or external history entry must never be treated as the chat return destination.
    for (const path of ['/', '/?project=3', '/chats', '/c/12?foo=bar']) expect(isChatHistoryRoute(path)).toBe(true)
    for (const path of [null, '/settings', '/projects/3', '/c/12/edit', 'https://example.com/c/12']) expect(isChatHistoryRoute(path)).toBe(false)
  })

  it('clears undeclared reasoning efforts without erasing other capability flags', () => {
    // Storing [] or dropping vision would break the declared-capabilities payload contract.
    const source = { vision: true, tools: false, reasoning_efforts: ['high'] as const }
    const capabilities = { ...source, reasoning_efforts: ['high' as const] }
    expect(modelCapabilitiesWithEfforts(capabilities, [])).toEqual({ vision: true, tools: false })
    expect(modelCapabilitiesWithEfforts(capabilities, ['max', 'low', 'max'])).toEqual({ vision: true, tools: false, reasoning_efforts: ['low', 'max'] })
    expect(capabilities.reasoning_efforts).toEqual(['high'])
  })

  it('serializes rapid model writes and only publishes the newest result', async () => {
    // Concurrent writes can reach the server out of order and erase the user's later intent.
    const firstWrite = deferred<void>()
    const write = vi.fn().mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(undefined)
    const apply = vi.fn()
    const read = vi.fn().mockResolvedValue([{ ...model, enabled: false }])
    const queue = createModelWriteQueue({ write, read, apply, onError: vi.fn() })
    const first = queue(2, { capabilities: { vision: true } })
    const second = queue(2, { enabled: false })
    await Promise.resolve()
    expect(write.mock.calls).toEqual([[2, { capabilities: { vision: true } }]])
    firstWrite.resolve()
    await Promise.all([first, second])
    expect(write.mock.calls).toEqual([[2, { capabilities: { vision: true } }], [2, { enabled: false }]])
    expect(read).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledExactlyOnceWith([{ ...model, enabled: false }])
  })

  it('discards a reread when another edit arrived while it was in flight', async () => {
    // A sequence check only before the read would repaint the row with stale state.
    const staleRead = deferred<Model[]>()
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
