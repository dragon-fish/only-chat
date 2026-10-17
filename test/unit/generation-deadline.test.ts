import { describe, expect, it } from 'vitest'
import { generationDeadline } from '@/server/plugins/hub'
import { GENERATION_IDLE_TIMEOUT_MS, GENERATION_MAX_MS } from '@/shared/constants'

const job = (startedAt: number, lastProgressAt: number, running: string[] = []) =>
  ({ startedAt, lastProgressAt, toolsRunning: new Set(running) })

describe('generationDeadline', () => {
  it('times out a stream that stopped producing, measured from its last part', () => {
    expect(generationDeadline(job(0, 1000), 2000)).toBe(1000 + GENERATION_IDLE_TIMEOUT_MS)
  })

  it('does not count time inside a running tool as idle', () => {
    const now = 1000 + GENERATION_IDLE_TIMEOUT_MS * 3
    expect(generationDeadline(job(0, 1000, ['call_1']), now)).toBe(now + GENERATION_IDLE_TIMEOUT_MS)
  })

  it('stops a steadily progressing generation at the hard cap', () => {
    const now = GENERATION_MAX_MS - 1
    expect(generationDeadline(job(0, now), now)).toBe(GENERATION_MAX_MS)
  })
})
