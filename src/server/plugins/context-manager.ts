import { Context, Service } from 'cordis'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { InterfaceProtocol, Message, StepUsage, Usage } from '@/shared/models'
import type { ModelMetadata } from '@/shared/model-metadata'
import type { Part, ToolResultPart } from '@/shared/parts'
import { effectivePluginSwitches } from '@/shared/plugins'
import { pluginManifests } from '@/shared/plugin-manifests'
import type { ContextProjection } from './hub/checkpoint'
import type { CheckpointBlock } from './hub/checkpoint-writer'
import type { SdkProviderOptions } from './llm/messages'

export type ContextDecision = 'continue' | 'checkpoint'
export type CompactionTrigger = 'auto' | 'manual' | 'overflow'

/** The model a turn runs on, as a context manager needs to judge its window. */
export interface ContextModel {
  providerId: number
  modelId: string
  protocol: InterfaceProtocol
  metadata: ModelMetadata
  /** `metadata.limit.context`; null when the catalog does not say. */
  contextLimit: number | null
}

/** One real request's usage and the assistant message it was recorded on. */
export interface MeasuredStep {
  usage: StepUsage
  messageId: number
}

/** Handed to `beforeTurn` and `afterTurn` (spec §2). */
export interface TurnInput {
  userId: number
  conversationId: number
  projectId: number | null
  model: ContextModel
  /**
   * Before a turn: the path ending at the message the reply will answer — its user message, or the
   * tool message a continuation resumes from. After a turn: the path ending at the finished reply.
   */
  projection: ContextProjection
  /**
   * The latest request whose usage was recorded on `projection.visible`, from stored message usage;
   * null when nothing after the last checkpoint has one (just compacted, or the usage was lost to an
   * interruption). Everything on `visible` after `messageId` was not part of that request.
   */
  lastStep: MeasuredStep | null
}

/** Handed to `afterStep`, between two steps of one run, when the run would otherwise continue. */
export interface StepInput extends TurnInput {
  /** This run's completed steps, oldest first, from the SDK; the last is the request just answered. */
  steps: StepUsage[]
  /** Steps this logical turn has used across all its continuations, `steps` included. */
  stepsUsed: number
  /** Results of the last step's tool calls: the next request carries them, no request has yet. */
  toolResults: readonly ToolResultPart[]
  /** Attachments tools delivered that no request has carried yet. */
  pendingAttachments: readonly number[]
  /** Interjections and task notifications waiting for the next step boundary. */
  pendingInterjections: readonly Part[]
}

/** What a request of the turn being compacted carries, ready to be reused (spec §3.4). */
export interface ComposeRequest {
  /** Exactly as `buildModelMessages` builds the turn's request at the checkpoint's position. */
  messages: ModelMessage[]
  /** The turn's tool definitions, without `execute`: a summary request must never run a tool. */
  tools: ToolSet
  /** The turn's model, created for its provider, interface and credentials. */
  languageModel: LanguageModel
  providerOptions: SdkProviderOptions
}

/** The user-side inputs a mid-turn checkpoint has to carry into its continuation (spec §3.6). */
export interface ComposeTurn {
  /** This turn's user message, and the interjections and task notifications delivered since, in order. */
  inputs: readonly Message[]
  /** Attachments of `inputs`. */
  attachments: readonly number[]
  /** Attachments tools returned that no request has carried yet. */
  pendingToolAttachments: readonly number[]
}

export interface ComposeInput extends ComposeRequest {
  trigger: CompactionTrigger
  userId: number
  conversationId: number
  projectId: number | null
  model: ContextModel
  /** The path ending at the message the checkpoint will be written under. */
  projection: ContextProjection
  /** What `checkpoint/compose` collected, in manifest order. */
  blocks: readonly CheckpointBlock[]
  contributors: readonly string[]
  /** Aborted when the person stops the conversation; nothing is written after that. */
  signal: AbortSignal
  /** Set when the turn goes on after the checkpoint (before a turn, mid-turn, after an overflow). */
  turn: ComposeTurn | null
  /** The person's own emphasis for a manual compaction. */
  focus: string | null
}

/** The core adds `type`, `plugin` and `contributors`. */
export interface CheckpointDraft {
  content: string
  attachments: number[]
  data: unknown
  /** What writing the summary cost; stored as the checkpoint message's usage. */
  usage: Usage | null
}

/**
 * Decides when a conversation is compacted and writes the summary (spec §2). The core runs the
 * flows: it holds the conversation, collects plugin blocks, writes the checkpoint and continues.
 * A hook that throws counts as 'continue'; `compose` throwing counts as a failed compaction.
 */
export interface ContextManager {
  /** Before a turn's first request, before its reply exists. */
  beforeTurn(input: TurnInput): ContextDecision | Promise<ContextDecision>
  /** After a step, when the run would continue with another one. */
  afterStep(input: StepInput): ContextDecision | Promise<ContextDecision>
  /** After a turn finished normally. */
  afterTurn(input: TurnInput): ContextDecision | Promise<ContextDecision>
  /** Whether a provider error means the request exceeded the context window. */
  isOverflow(error: unknown): boolean
  compose(input: ComposeInput): Promise<CheckpointDraft | { error: string }>
}

export interface ActiveContextManager {
  pluginId: string
  manager: ContextManager
}

/**
 * The context manager registry (spec §2): at most one, and it counts only while its plugin is
 * switched on. The plugin has no tools, so its master switch alone decides, never a tool selection.
 */
export class ContextManagers extends Service {
  static readonly provide = 'contextManager'

  private entry: ActiveContextManager | null = null

  constructor(ctx: Context) {
    super(ctx, 'contextManager')
  }

  /** Registration belongs to the caller's Cordis lifecycle and is reversible. A second one throws. */
  register(pluginId: string, manager: ContextManager): () => void {
    if (this.entry) throw new Error(`a context manager is already registered by ${this.entry.pluginId}`)
    return this.ctx.effect(() => {
      const entry = { pluginId, manager }
      this.entry = entry
      return () => {
        if (this.entry === entry) this.entry = null
      }
    }, `contextManager.register(${pluginId})`) as () => void
  }

  /** The registered manager, if its plugin is on in these switches (`user.settings.plugins`). */
  active(switches: Readonly<Record<string, boolean>>): ActiveContextManager | undefined {
    if (!this.entry) return undefined
    return effectivePluginSwitches(pluginManifests, switches)[this.entry.pluginId] === true ? this.entry : undefined
  }
}

export const ContextManagersPlugin = {
  name: 'context-manager',
  async apply(ctx: Context) {
    await ctx.plugin(ContextManagers)
  },
}
