import { describe, expect, it } from 'vitest'
import { formatCountdown, liveViewPhase } from '../../src/plugins/cloudflare-browser-run/client/live-view-idle'

describe('liveViewPhase', () => {
  const idleMs = 600_000

  it('shows the frame while activity is within the idle window', () => {
    expect(liveViewPhase({ hidden: false, lastActivityAt: 1_000, now: 1_000 + idleMs - 1, idleMs })).toBe('shown')
  })

  it('idles the frame once the window has fully elapsed', () => {
    expect(liveViewPhase({ hidden: false, lastActivityAt: 1_000, now: 1_000 + idleMs, idleMs })).toBe('idle')
  })

  it('hides the frame whenever the page is hidden, even with fresh activity', () => {
    expect(liveViewPhase({ hidden: true, lastActivityAt: 1_000, now: 1_000, idleMs })).toBe('hidden')
  })
})

describe('formatCountdown', () => {
  it('rounds up to the next second and pads seconds', () => {
    expect(formatCountdown(65_001)).toBe('1:06')
    expect(formatCountdown(600_000)).toBe('10:00')
  })

  it('never goes below zero', () => {
    expect(formatCountdown(-5_000)).toBe('0:00')
  })
})
