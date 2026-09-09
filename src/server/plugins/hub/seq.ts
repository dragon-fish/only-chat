/**
 * Per-conversation monotonic counter. Initialised once from the db's max(seq), then purely in memory.
 * The UserHub DO is the single writer for its user, so no cross-instance coordination is needed.
 */
export class SeqAllocator {
  private readonly _counters = new Map<number, number>()
  private readonly _inits = new Map<number, Promise<void>>()

  async allocate(conversationId: number, loadMax: () => Promise<number>): Promise<number> {
    if (!this._counters.has(conversationId)) {
      let init = this._inits.get(conversationId)
      if (!init) {
        init = loadMax().then((max) => { this._counters.set(conversationId, max) }).finally(() => { this._inits.delete(conversationId) })
        this._inits.set(conversationId, init)
      }
      await init
    }
    const next = (this._counters.get(conversationId) ?? 0) + 1
    this._counters.set(conversationId, next)
    return next
  }

  forget(conversationId: number): void {
    this._counters.delete(conversationId)
  }
}
