import { describe, expect, it } from 'vitest'
import { ClientPluginHost } from '@/client/plugins/host'

describe('ClientPluginHost', () => {
  it('deduplicates concurrent loads and resolves a registered renderer', async () => {
    let loads = 0
    const host = new ClientPluginHost({
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', defaultTools: ['ask_user'] }],
      loaders: { ask_user: async () => { loads++; return { setup: ctx => ctx.tools.register('ask_user', { name: 'card' }) } } },
    })
    const [first, second] = await Promise.all([host.ensureToolRenderer('ask_user'), host.ensureToolRenderer('ask_user')])
    expect(loads).toBe(1)
    expect(first).toEqual({ name: 'card' })
    expect(second).toEqual({ name: 'card' })
  })

  it('disposes registered renderers and retries a failed lazy load', async () => {
    let attempts = 0
    const host = new ClientPluginHost({
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', defaultTools: ['ask_user'] }],
      loaders: { ask_user: async () => {
        attempts++
        if (attempts === 1) throw new Error('network')
        return { setup: ctx => ctx.tools.register('ask_user', { name: 'card' }) }
      } },
    })
    await expect(host.ensurePlugin('ask_user')).rejects.toThrow('network')
    await host.ensurePlugin('ask_user')
    expect(host.renderer('ask_user')).toEqual({ name: 'card' })
    host.disposePlugin('ask_user')
    expect(host.renderer('ask_user')).toBeUndefined()
  })
})
