import type { Message } from '@/shared/models'
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
  /** Root → leaf, what the model is about to see. */
  path: readonly Message[]
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
