/** What a command refused by a held conversation operation reports (spec §1.4). */
export const COMPACTING_MESSAGE = '正在压缩上下文'

/**
 * One conversation operation in progress. `signal` aborts when the person stops that conversation,
 * and whoever holds the handle must then give up without writing and release.
 */
export interface OperationHandle {
  readonly conversationId: number
  readonly signal: AbortSignal
  /**
   * Frees the conversation, then runs what waited on it — queued task notifications — and resolves
   * once that is done. Idempotent. Await it: like `settleTask`, the caller's request is what keeps
   * the Durable Object alive for the work it starts.
   */
  release(): Promise<void>
}

interface Held {
  controller: AbortController
  released: Promise<void>
}

/**
 * Per-conversation operation lock (spec §1.4). Compaction holds it from the moment it starts writing
 * a summary until the checkpoint is written and any continuation has started; while it is held, every
 * command that would move or remove that conversation's head is refused with `COMPACTING_MESSAGE`.
 *
 * In memory only, like the inflight map: a Durable Object that dies mid-operation has written nothing
 * (the checkpoint commit is one batch), so there is nothing to recover and nothing to unlock.
 */
export class ConversationOperations {
  private readonly held = new Map<number, Held>()

  /** `onRelease` runs after every release, for work that waited on the lock. */
  constructor(private readonly onRelease: (conversationId: number) => Promise<void>) {}

  isHeld(conversationId: number): boolean {
    return this.held.has(conversationId)
  }

  /** Conversation ids with an operation in progress, for the snapshot a reconnecting client reads. */
  heldConversations(): number[] {
    return [...this.held.keys()]
  }

  /** Throws `COMPACTING_MESSAGE` while an operation holds this conversation. */
  assertFree(conversationId: number): void {
    if (this.held.has(conversationId)) throw new Error(COMPACTING_MESSAGE)
  }

  /**
   * Takes the lock, or throws `COMPACTING_MESSAGE` when it is already held — a second compaction is
   * refused like any other command. Synchronous on purpose: check and take cannot be split by an await.
   */
  acquire(conversationId: number): OperationHandle {
    this.assertFree(conversationId)
    const controller = new AbortController()
    let settle!: () => void
    const released = new Promise<void>((resolve) => { settle = resolve })
    this.held.set(conversationId, { controller, released })
    let releasing: Promise<void> | undefined
    const release = (): Promise<void> => {
      releasing ??= (async () => {
        if (this.held.get(conversationId)?.controller === controller) this.held.delete(conversationId)
        settle()
        await this.onRelease(conversationId).catch(error => console.error('work waiting on a conversation operation failed', error))
      })()
      return releasing
    }
    return { conversationId, signal: controller.signal, release }
  }

  /** Holds the lock around `run`, releasing it however `run` ends. */
  async run<T>(conversationId: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const handle = this.acquire(conversationId)
    try {
      return await run(handle.signal)
    } finally {
      await handle.release()
    }
  }

  /**
   * Aborts the operation holding this conversation and resolves once it has released; undefined when
   * nothing holds it. The caller bounds the wait — an operation ignoring its signal must not hang a stop.
   */
  abort(conversationId: number, reason: string): Promise<void> | undefined {
    const held = this.held.get(conversationId)
    if (!held) return undefined
    held.controller.abort(reason)
    return held.released
  }
}
