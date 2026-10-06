import type { Message } from '@/shared/models'
import type { CheckpointPart } from '@/shared/parts'
import type { FileLabeler } from '../llm/messages'

/**
 * One generation as plugins see it before the model is called, handed to `generation/prepare`.
 *
 * `state` is the same map every tool of this generation receives as `ToolContext.turn`, so what a
 * plugin prepares here its tools find later, and it dies with the generation. Nothing about it may
 * outlive the turn or be shared between conversations.
 */
export interface GenerationTurn {
  userId: number
  conversationId: number
  projectId: number | null
  /** The tools this generation offers, requirements included. */
  toolIds: readonly string[]
  /**
   * Root → leaf, the whole structural path, checkpoints and all. What this turn may reach — which
   * attachments it can name, for one — is decided on this, never on `visible` (spec §1.3).
   */
  path: readonly Message[]
  /** The last checkpoint on `path`, which the model reads in place of everything before it. */
  checkpoint: CheckpointPart | null
  /**
   * The messages after the last checkpoint message, or `path` when there is none. Anything that asks
   * what the model has already been shown reads this, together with `checkpoint`.
   */
  visible: readonly Message[]
  state: Map<string, unknown>
  /** Whether the generating model can take a file of this MIME (spec §3.4). */
  canReadFile(mime: string): boolean
  /** Set by at most one plugin. Absent, files reach the model with nothing said about them. */
  labeler?: FileLabeler
  /**
   * New notes for user messages on this path, as `<system-reminder>` text the person never typed.
   * The core stores them on their messages (`messages.notes`) before building the prompt, and every
   * later turn replays them from there; a plugin adds a note once, and can tell it already did from
   * the message's own `notes`.
   */
  notes: Array<{ pluginId: string, messageId: number, text: string, at?: 'start' }>
}
