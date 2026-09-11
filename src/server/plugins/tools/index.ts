import { Context, Service } from 'cordis'
import type { Tool } from 'ai'
import type { DB } from '../../db/client'
import type { Assets } from '../assets'

/**
 * What a tool factory is handed for one generation.
 *
 * Identity comes from the runtime and never from tool input: a tool can only reach the user,
 * Conversation and Project it was built inside. `assistantMessageId` is why tools are built after
 * the assistant shell exists rather than while the target is being resolved — a tool that records
 * provenance needs the message it is about to answer into.
 *
 * `turn` is a scratchpad shared by every tool built for that generation and discarded with it, so a
 * per-turn call budget lives here rather than in the registry and cannot leak across conversations
 * or users.
 */
export interface ToolContext {
  userId: number
  conversationId: number
  projectId: number | null
  assistantMessageId: number
  /** The owning plugin's parsed configuration; empty for a plugin that declares none. */
  config: Record<string, unknown>
  turn: Map<string, unknown>
  db: DB
  assets: Assets
  /** Aborted when the generation is stopped; long work must give up with it. */
  signal: AbortSignal
}

export type ToolFactory = (ctx: ToolContext) => Tool

/** The half of `ToolContext` a caller supplies; the registry fills in `config` per plugin. */
export type ToolResolution = Omit<ToolContext, 'config'>

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
   * Which selected tools would actually run, without building any of them.
   *
   * Answers the "does this model support tool calls" check while the target is still being resolved,
   * long before there is an assistant message to build tools against.
   */
  usable(ids: readonly string[], enabledPlugins: Record<string, boolean>): string[] {
    return this.normalize(ids).filter(id => enabledPlugins[this.entries.get(id)!.pluginId] === true)
  }

  /**
   * Builds selected tools in stable order; global disablement suppresses without rewriting
   * snapshots. A plugin whose required configuration is unset throws here rather than reaching the
   * provider with a missing credential.
   */
  async resolve(
    ids: readonly string[],
    enabledPlugins: Record<string, boolean>,
    resolution: ToolResolution,
  ): Promise<[string, Tool][]> {
    const selected = this.usable(ids, enabledPlugins).map(id => [id, this.entries.get(id)!] as const)
    const configs = new Map<string, Record<string, unknown>>()
    for (const pluginId of new Set(selected.map(([, entry]) => entry.pluginId))) {
      configs.set(pluginId, await this.ctx.pluginConfig.readIfConfigurable(resolution.userId, pluginId))
    }
    return selected.map(([id, entry]) => [id, entry.factory({ ...resolution, config: configs.get(entry.pluginId)! })])
  }
}

export const ToolRegistryPlugin = {
  name: 'tools',
  async apply(ctx: Context) {
    await ctx.plugin(ToolRegistry)
  },
}
