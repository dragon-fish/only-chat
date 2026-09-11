import { describe, expect, it } from 'vitest'
import { runCurrentTime } from '@/plugins/datetime/server/runner'

const instant = new Date('2026-09-11T16:30:00.000Z')

describe('runCurrentTime', () => {
  it('renders the same instant in whichever zone was asked for', () => {
    const shanghai = runCurrentTime({ timezone: 'Asia/Shanghai' }, instant)
    const london = runCurrentTime({ timezone: 'Europe/London' }, instant)
    expect(shanghai).toMatchObject({ timezone: 'Asia/Shanghai', iso: instant.toISOString() })
    expect(london).toMatchObject({ timezone: 'Europe/London', iso: instant.toISOString() })
    // One batch of parallel calls must agree on the instant and differ only in the rendering.
    expect('local' in shanghai && 'local' in london && shanghai.local).not.toBe(london.local)
  })

  it('defaults to UTC when no zone is given or the field is blank', () => {
    expect(runCurrentTime({}, instant)).toMatchObject({ timezone: 'UTC' })
    expect(runCurrentTime({ timezone: '   ' }, instant)).toMatchObject({ timezone: 'UTC' })
  })

  it('rejects a zone Intl does not know, rather than guessing one', () => {
    expect(runCurrentTime({ timezone: 'Mars/Olympus' }, instant))
      .toEqual({ error: '未知时区：Mars/Olympus。请使用 IANA 名称，如 Asia/Shanghai。' })
  })
})
