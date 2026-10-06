import { describe, expect, it } from 'vitest'
import { ClientPluginHost } from '@/client/plugins/host'

describe('ClientPluginHost', () => {
  it('deduplicates concurrent loads and resolves a registered renderer', async () => {
    let loads = 0
    const host = new ClientPluginHost({
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', tools: [{ id: 'ask_user', name: 'ask_user', description: 'ask_user' }] }],
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
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', tools: [{ id: 'ask_user', name: 'ask_user', description: 'ask_user' }] }],
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

  it('rejects duplicate ownership and registrations outside the plugin manifest', async () => {
    expect(() => new ClientPluginHost({
      manifests: [
        { id: 'first', name: 'First', description: 'First', tools: [{ id: 'shared', name: 'shared', description: 'shared' }] },
        { id: 'second', name: 'Second', description: 'Second', tools: [{ id: 'shared', name: 'shared', description: 'shared' }] },
      ],
      loaders: {},
    })).toThrow(/owned by multiple plugins/i)

    const host = new ClientPluginHost({
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', tools: [{ id: 'ask_user', name: 'ask_user', description: 'ask_user' }] }],
      loaders: { ask_user: async () => ({ setup: ctx => ctx.tools.register('foreign', { name: 'card' }) }) },
    })
    await expect(host.ensurePlugin('ask_user')).rejects.toThrow(/does not own tool/i)
    expect(host.renderer('foreign')).toBeUndefined()
  })

  it('rolls back partial registrations when setup throws and permits a retry', async () => {
    let attempts = 0
    const host = new ClientPluginHost({
      manifests: [{ id: 'ask_user', name: 'Ask', description: 'Ask', tools: [{ id: 'ask_user', name: 'ask_user', description: 'ask_user' }] }],
      loaders: { ask_user: async () => ({
        setup: (ctx) => {
          attempts++
          ctx.tools.register('ask_user', { attempt: attempts })
          if (attempts === 1) throw new Error('setup failed')
        },
      }) },
    })

    await expect(host.ensurePlugin('ask_user')).rejects.toThrow('setup failed')
    expect(host.renderer('ask_user')).toBeUndefined()
    await host.ensurePlugin('ask_user')
    expect(host.renderer('ask_user')).toEqual({ attempt: 2 })
  })

  it('routes plugin events to their own plugin and commands through the sender', async () => {
    const received: Array<[string, unknown]> = []
    const sent: unknown[] = []
    const manifest = (id: string) => ({ id, name: id, description: id, tools: [{ id: `${id}_tool`, name: id, description: id }] })
    const host = new ClientPluginHost({
      manifests: [manifest('alpha'), manifest('beta')],
      loaders: {
        alpha: async () => ({ setup: ctx => ctx.events.on(payload => received.push(['alpha', payload])) }),
        beta: async () => ({ setup: (ctx) => {
          ctx.events.on(payload => received.push(['beta', payload]))
          ctx.events.send({ hello: 'server' })
        } }),
      },
    })
    host.setSender((command) => { sent.push(command); return true })
    await host.ensurePlugin('alpha')
    await host.ensurePlugin('beta')
    host.dispatchEvent('alpha', { n: 1 })
    host.dispatchEvent('gamma', { n: 2 })
    expect(received).toEqual([['alpha', { n: 1 }]])
    expect(sent).toEqual([{ type: 'plugin.command', plugin: 'beta', payload: { hello: 'server' } }])
    host.disposePlugin('alpha')
    host.dispatchEvent('alpha', { n: 3 })
    expect(received).toHaveLength(1)
  })

  it('lazily loads the plugin that renders a notification, and has none for an unknown plugin', async () => {
    const host = new ClientPluginHost({
      manifests: [{ id: 'image_generation', name: 'Images', description: 'Images', tools: [{ id: 'generate_image', name: 'g', description: 'g' }] }],
      loaders: { image_generation: async () => ({ setup: ctx => { ctx.notifications.register({ name: 'thumbs' }) } }) },
    })
    expect(await host.ensureNotificationRenderer('image_generation')).toEqual({ name: 'thumbs' })
    expect(await host.ensureNotificationRenderer('nobody')).toBeUndefined()
  })

  it('lazily loads the plugin that renders its checkpoints, one renderer per plugin, none for an unknown plugin', async () => {
    const compaction = { id: 'context_compaction', name: 'C', description: 'C', tools: [] }
    const host = new ClientPluginHost({
      manifests: [compaction, { id: 'twice', name: 'T', description: 'T', tools: [] }],
      loaders: {
        context_compaction: async () => ({ setup: ctx => { ctx.checkpoints.register({ name: 'divider' }) } }),
        twice: async () => ({ setup: (ctx) => {
          ctx.checkpoints.register({ name: 'first' })
          ctx.checkpoints.register({ name: 'second' })
        } }),
      },
    })
    expect(await host.ensureCheckpointRenderer('context_compaction')).toEqual({ name: 'divider' })
    // A checkpoint from a plugin this build does not know falls back to the core divider.
    expect(await host.ensureCheckpointRenderer('gone')).toBeUndefined()
    await expect(host.ensurePlugin('twice')).rejects.toThrow(/checkpoint renderer already registered/)
    host.disposePlugin('context_compaction')
    expect(await host.ensureCheckpointRenderer('context_compaction')).toEqual({ name: 'divider' })
  })

  describe('slash commands', () => {
    const env = { conversationId: 7, streaming: false, compacting: false, toast: () => {} }
    const manifest = (id: string, commands: string[]) => ({
      id, name: id, description: id, tools: [], slashCommands: commands.map(name => ({ name, description: name })),
    })

    it('rejects a command its manifest does not declare, and a second registration', async () => {
      const host = new ClientPluginHost({
        manifests: [manifest('alpha', ['go']), manifest('beta', ['other'])],
        loaders: {
          alpha: async () => ({ setup: (ctx) => { ctx.slashCommands.register('other', { run: async () => {} }) } }),
          beta: async () => ({ setup: (ctx) => {
            ctx.slashCommands.register('other', { run: async () => {} })
            ctx.slashCommands.register('other', { run: async () => {} })
          } }),
        },
      })
      await expect(host.ensurePlugin('alpha')).rejects.toThrow(/does not declare slash command other/i)
      await expect(host.ensurePlugin('beta')).rejects.toThrow(/already registered/i)
    })

    it('rejects two manifests declaring the same command', () => {
      expect(() => new ClientPluginHost({ manifests: [manifest('a', ['go']), manifest('b', ['go'])], loaders: {} })).toThrow(/go/)
    })

    it('loads the owning plugin on demand and runs with a context scoped to it', async () => {
      const sent: unknown[] = []
      const seen: unknown[] = []
      let loads = 0
      const host = new ClientPluginHost({
        manifests: [manifest('alpha', ['go'])],
        loaders: { alpha: async () => {
          loads++
          return { setup: (ctx) => {
            ctx.slashCommands.register('go', {
              run: async (command, args) => {
                seen.push({ conversationId: command.conversationId, streaming: command.streaming, compacting: command.compacting, args })
                await new Promise<void>((resolve) => {
                  const off = command.on((payload) => { seen.push(payload); off(); resolve() })
                  command.send({ type: 'go', args })
                })
              },
            })
          } }
        } },
      })
      host.setSender((command) => { sent.push(command); queueMicrotask(() => host.dispatchEvent('alpha', { ok: true })); return true })
      await host.runSlashCommand({ pluginId: 'alpha', name: 'go', args: 'now' }, env)
      expect(loads).toBe(1)
      expect(sent).toEqual([{ type: 'plugin.command', plugin: 'alpha', payload: { type: 'go', args: 'now' } }])
      expect(seen).toEqual([{ conversationId: 7, streaming: false, compacting: false, args: 'now' }, { ok: true }])
    })

    it('refuses with the reason enabled gives, without running', async () => {
      let ran = false
      const host = new ClientPluginHost({
        manifests: [manifest('alpha', ['go'])],
        loaders: { alpha: async () => ({ setup: (ctx) => {
          ctx.slashCommands.register('go', {
            enabled: command => (command.streaming ? '生成中' : true),
            run: async () => { ran = true },
          })
        } }) },
      })
      await expect(host.runSlashCommand({ pluginId: 'alpha', name: 'go', args: '' }, { ...env, streaming: true })).rejects.toThrow('生成中')
      expect(ran).toBe(false)
      await host.runSlashCommand({ pluginId: 'alpha', name: 'go', args: '' }, env)
      expect(ran).toBe(true)
    })

    it('releases the registration with the plugin', async () => {
      let runs = 0
      const host = new ClientPluginHost({
        manifests: [manifest('alpha', ['go'])],
        loaders: { alpha: async () => ({ setup: (ctx) => { ctx.slashCommands.register('go', { run: async () => { runs++ } }) } }) },
      })
      await host.ensurePlugin('alpha')
      host.disposePlugin('alpha')
      // Reinstalling registers again; a leftover registration would make this throw "already registered".
      await host.runSlashCommand({ pluginId: 'alpha', name: 'go', args: '' }, env)
      expect(runs).toBe(1)
    })

    it('fails when the plugin never registers a command it declares', async () => {
      const host = new ClientPluginHost({ manifests: [manifest('alpha', ['go'])], loaders: { alpha: async () => ({ setup: () => {} }) } })
      await expect(host.runSlashCommand({ pluginId: 'alpha', name: 'go', args: '' }, env)).rejects.toThrow(/go/)
    })
  })
})
