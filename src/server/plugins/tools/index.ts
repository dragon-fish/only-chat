import { Context, Service } from 'cordis'
import type { Tool } from 'ai'

/**
 * What a tool factory is handed for one generation. `turn` is a scratchpad shared by every tool
 * built for that generation and discarded with it — a per-turn call budget lives here, not in the
 * registry, so it cannot leak across conversations or users.
 */
export interface ToolContext {
  userId: number
  /** The owning plugin's parsed configuration; empty for a plugin that declares none. */
  config: Record<string, unknown>
  turn: Map<string, unknown>
}

export type ToolFactory = (ctx: ToolContext) => Tool

/** The half of `ToolContext` a caller supplies; the registry fills in `config` per plugin. */
export interface ToolResolution {
  userId: number
  turn: Map<string, unknown>
}

interface RegisteredTool {
  pluginId: string
  factory: ToolFactory
}

/** Server-owned catalog of built-in tools. Resolution never silently drops a selected tool. */
export class ToolRegistry extends Service {
  static readonly provide = 'tools'
  static readonly inject = ['pluginConfig']

  private readonly entries = new Map<string, RegisteredTool>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /** Registration belongs to the caller's Cordis lifecycle and is reversible. */
  register(pluginId: string, toolId: string, factory: ToolFactory): () => void {
    if (this.entries.has(toolId)) throw new Error(`tool already registered: ${toolId}`)
    return this.ctx.effect(() => {
      this.entries.set(toolId, { pluginId, factory })
      return () => {
        if (this.entries.get(toolId)?.factory === factory) this.entries.delete(toolId)
      }
    }, `tools.register(${toolId})`) as () => void
  }

  /** Canonicalizes a snapshot while rejecting IDs that no installed server plugin owns. */
  normalize(ids: readonly string[]): string[] {
    const normalized = [...new Set(ids)].sort()
    for (const id of normalized) if (!this.entries.has(id)) throw new Error(`unknown tool: ${id}`)
    return normalized
  }

  /**
   * Resolves selected tools in stable order; global disablement suppresses without rewriting
   * snapshots. A plugin whose required configuration is unset throws here rather than reaching the
   * provider with a missing credential.
   */
  async resolve(
    ids: readonly string[],
    enabledPlugins: Record<string, boolean>,
    resolution: ToolResolution,
  ): Promise<[string, Tool][]> {
    const selected = this.normalize(ids)
      .map(id => [id, this.entries.get(id)!] as const)
      .filter(([, entry]) => enabledPlugins[entry.pluginId] === true)
    const configs = new Map<string, Record<string, unknown>>()
    for (const pluginId of new Set(selected.map(([, entry]) => entry.pluginId))) {
      configs.set(pluginId, await this.ctx.pluginConfig.readIfConfigurable(resolution.userId, pluginId))
    }
    return selected.map(([id, entry]) => [id, entry.factory({
      userId: resolution.userId,
      config: configs.get(entry.pluginId)!,
      turn: resolution.turn,
    })])
  }
}

export const ToolRegistryPlugin = {
  name: 'tools',
  async apply(ctx: Context) {
    await ctx.plugin(ToolRegistry)
  },
}
