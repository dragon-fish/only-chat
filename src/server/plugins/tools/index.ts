import { Context, Service } from 'cordis'
import type { Tool } from 'ai'
import type { ConversationPluginSettings, Message } from '@/shared/models'
import { conversationConfigOf, pluginAvailableIn, pluginToolGroups, type ConversationScope } from '@/shared/plugins'
import { findPluginManifest } from '@/shared/plugin-manifests'
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
  /** The owning plugin's per-conversation settings with defaults applied; empty when it declares none. */
  conversationConfig: Record<string, unknown>
  turn: Map<string, unknown>
  db: DB
  assets: Assets
  /** Aborted when the generation is stopped; long work must give up with it. */
  signal: AbortSignal
  /** Whether the generating model declares image input, so a tool knows if a picture is worth sending. */
  acceptsImages: boolean
  /**
   * Where this deployment is reachable, for a tool handing out a link someone off this origin has
   * to open. Comes from the connection that asked for the generation, never from configuration.
   * Null on a hub that has never been connected to, which no link is worth failing a turn over.
   */
  publicOrigin: string | null
  /**
   * The messages this generation was built from, root to leaf — what the model can actually see.
   *
   * A tool that would ask for something already on screen can look here instead. `turn` holds what
   * this generation has done since; together they are the whole of what the caller knows.
   */
  path: readonly Message[]
}

export type ToolFactory = (ctx: ToolContext) => Tool

/** The half of `ToolContext` a caller supplies; the registry fills in the per-plugin halves. */
export type ToolResolution = Omit<ToolContext, 'config' | 'conversationConfig'> & {
  /** The conversation's raw `plugin_settings`; each plugin sees only its own entry, parsed. */
  pluginSettings: ConversationPluginSettings | null
}

/**
 * How a tool without `execute` is answered by a person. The hub owns the pause and the resume; the
 * plugin owns what an answer looks like, which is the only part that differs between such tools.
 */
/** Which call a person is answering; identity comes from the runtime, never from the client. */
export interface HumanToolCall {
  userId: number
  conversationId: number
  messageId: number
  callId: string
}

export interface HumanToolProtocol {
  /** Validates the client's answer against the persisted call and returns the result content. */
  respond(input: unknown, result: unknown, call: HumanToolCall): unknown
  /** The result content recorded when the person moves on (sends a message) without answering. */
  skip(input: unknown): unknown
  /** Whether a recorded result is such a skip, which must not resume the generation on its own. */
  skipped(content: unknown): boolean
}

interface RegisteredTool {
  pluginId: string
  factory: ToolFactory
  human?: HumanToolProtocol
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
  register(pluginId: string, toolId: string, factory: ToolFactory, human?: HumanToolProtocol): () => void {
    if (this.entries.has(toolId)) throw new Error(`tool already registered: ${toolId}`)
    return this.ctx.effect(() => {
      this.entries.set(toolId, { pluginId, factory, ...(human ? { human } : {}) })
      return () => {
        if (this.entries.get(toolId)?.factory === factory) this.entries.delete(toolId)
      }
    }, `tools.register(${toolId})`) as () => void
  }

  /** The protocol a person answers this tool by; undefined for a tool the server executes itself. */
  human(toolId: string): HumanToolProtocol | undefined {
    return this.entries.get(toolId)?.human
  }

  /** `completedToolState`'s question, answered from the registry: only a human tool can be skipped. */
  skipped(toolId: string, content: unknown): boolean {
    return this.human(toolId)?.skipped(content) ?? false
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
   *
   * A snapshot stores tool ids, but what the person switched on was a group: the selector offers no
   * per-tool control, so a tool added to a group later was never deselected — it did not exist yet.
   * Resolving by group is what lets an existing conversation pick up a tool its plugin grew, instead
   * of silently withholding it until someone toggles the group off and on again.
   */
  usable(ids: readonly string[], enabledPlugins: Record<string, boolean>, scope: ConversationScope): string[] {
    return this.normalize(this.withGroupSiblings(ids)).filter((id) => {
      const pluginId = this.entries.get(id)!.pluginId
      const manifest = findPluginManifest(pluginId)
      return enabledPlugins[pluginId] === true && (manifest === undefined || pluginAvailableIn(manifest, scope))
    })
  }

  /** Every registered tool sharing a declared group with one the snapshot named. */
  private withGroupSiblings(ids: readonly string[]): string[] {
    const named = new Set(ids)
    const resolved = new Set(ids)
    for (const id of named) {
      const pluginId = this.entries.get(id)?.pluginId
      // An unknown id is left alone: rejecting it is `normalize`'s job, not this one's.
      if (pluginId === undefined) continue
      const manifest = findPluginManifest(pluginId)
      if (manifest === undefined) continue
      for (const group of pluginToolGroups(manifest)) {
        if (!group.tools.some(tool => named.has(tool.id))) continue
        for (const tool of group.tools) if (this.entries.has(tool.id)) resolved.add(tool.id)
      }
    }
    return [...resolved]
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
    const { pluginSettings, ...shared } = resolution
    const selected = this.usable(ids, enabledPlugins, { projectId: shared.projectId })
      .map(id => [id, this.entries.get(id)!] as const)
    const configs = new Map<string, Record<string, unknown>>()
    const conversationConfigs = new Map<string, Record<string, unknown>>()
    for (const pluginId of new Set(selected.map(([, entry]) => entry.pluginId))) {
      configs.set(pluginId, await this.ctx.pluginConfig.readIfConfigurable(shared.userId, pluginId))
      const manifest = findPluginManifest(pluginId)
      conversationConfigs.set(pluginId, manifest ? conversationConfigOf(manifest, pluginSettings) : {})
    }
    return selected.map(([id, entry]) => [id, entry.factory({
      ...shared,
      config: configs.get(entry.pluginId)!,
      conversationConfig: conversationConfigs.get(entry.pluginId)!,
    })])
  }
}

export const ToolRegistryPlugin = {
  name: 'tools',
  async apply(ctx: Context) {
    await ctx.plugin(ToolRegistry)
  },
}
