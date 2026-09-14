/**
 * When the Live View frame may stay mounted. The frame is a client of the browser session, and
 * Browser Run counts a connected client as activity, so a frame left open keeps the session — and
 * its billing — alive forever. Unmounting it hands the session back to the platform's idle timer.
 */
export type LiveViewPhase = 'shown' | 'hidden' | 'idle'

export function liveViewPhase(input: { hidden: boolean; lastActivityAt: number; now: number; idleMs: number }): LiveViewPhase {
  if (input.hidden) return 'hidden'
  return input.now - input.lastActivityAt >= input.idleMs ? 'idle' : 'shown'
}

/** `m:ss`, never negative. */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
