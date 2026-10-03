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
   * Set by at most one plugin: text that leads the first user message. It must be the same on every
   * turn of the conversation, so whatever produces it persists it rather than recomputing it — a
   * change rewrites the head of the cached prefix.
   */
  preamble?: string
  /**
   * Notes that end user messages, as `<system-reminder>` text the person never typed. A plugin adds
   * the ones it stored for messages on this path as well as any it makes now, and must store what it
   * makes: history is rebuilt from the database every turn, and a note that is not replayed would
   * rewrite the cached prefix from its message on.
   */
  notes: Array<{ pluginId: string, messageId: number, text: string }>
}
