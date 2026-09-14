import { Context, Service } from 'cordis'
import type { Hub } from './hub'

export type PluginCommandHandler = (payload: unknown, hub: Hub) => Promise<void> | void
export type PluginHostCallHandler = (payload: unknown, hub: Hub) => Promise<unknown> | unknown

/**
 * A plugin's own realtime channel to its client half. Payloads are opaque to the core: the hub
 * forwards `plugin.command` frames here by plugin id and broadcasts whatever a plugin hands to
 * `hub.broadcastPlugin` as `plugin.event`. Nothing is buffered — a client that needs the current
 * state on load asks for it with a command, because an event sent before the plugin's client code
 * was loaded is gone.
 */
export class PluginChannel extends Service {
  static readonly provide = 'pluginChannel'

  private readonly handlers = new Map<string, PluginCommandHandler>()
  private readonly hostHandlers = new Map<string, PluginHostCallHandler>()

  constructor(ctx: Context) {
    super(ctx, 'pluginChannel')
  }

  /** One handler per plugin; registration follows the caller's Cordis lifecycle. */
  onCommand(pluginId: string, handler: PluginCommandHandler): () => void {
    if (this.handlers.has(pluginId)) throw new Error(`plugin ${pluginId} already handles commands`)
    return this.ctx.effect(() => {
      this.handlers.set(pluginId, handler)
      return () => {
        if (this.handlers.get(pluginId) === handler) this.handlers.delete(pluginId)
      }
    }, `pluginChannel.onCommand(${pluginId})`) as () => void
  }

  async dispatch(pluginId: string, payload: unknown, hub: Hub): Promise<void> {
    const handler = this.handlers.get(pluginId)
    if (!handler) throw new Error(`plugin ${pluginId} accepts no commands`)
    await handler(payload, hub)
  }

  /**
   * Calls from the plugin's own trusted server code running outside this Durable Object — a
   * Worker entrypoint the plugin exports — as opposed to a client command. Kept apart from
   * `onCommand` so a handler can never mistake a browser for a trusted caller.
   */
  onHostCall(pluginId: string, handler: PluginHostCallHandler): () => void {
    if (this.hostHandlers.has(pluginId)) throw new Error(`plugin ${pluginId} already handles host calls`)
    return this.ctx.effect(() => {
      this.hostHandlers.set(pluginId, handler)
      return () => {
        if (this.hostHandlers.get(pluginId) === handler) this.hostHandlers.delete(pluginId)
      }
    }, `pluginChannel.onHostCall(${pluginId})`) as () => void
  }

  async dispatchHostCall(pluginId: string, payload: unknown, hub: Hub): Promise<unknown> {
    const handler = this.hostHandlers.get(pluginId)
    if (!handler) throw new Error(`plugin ${pluginId} accepts no host calls`)
    return handler(payload, hub)
  }
}

export const PluginChannelPlugin = {
  name: 'plugin-channel',
  async apply(ctx: Context) {
    await ctx.plugin(PluginChannel)
  },
}
