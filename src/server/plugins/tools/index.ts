import { Context, Service } from 'cordis'
import type { Tool } from 'ai'

export type ToolFactory = () => Tool

interface RegisteredTool {
  pluginId: string
  factory: ToolFactory
}

/** Server-owned catalog of built-in tools. Resolution never silently drops a selected tool. */
export class ToolRegistry extends Service {
  static readonly provide = 'tools'

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

  /** Resolves selected tools in stable order and rejects globally disabled plugin tools. */
  resolve(ids: readonly string[], enabledPlugins: Record<string, boolean>): [string, Tool][] {
    return this.normalize(ids).map((id) => {
      const entry = this.entries.get(id)!
      if (enabledPlugins[entry.pluginId] !== true) throw new Error(`tool is disabled: ${id}`)
      return [id, entry.factory()]
    })
  }
}

export const ToolRegistryPlugin = {
  name: 'tools',
  async apply(ctx: Context) {
    await ctx.plugin(ToolRegistry)
  },
}
