import { describe, expect, it } from 'vitest'
import { joinStash } from '@/shared/stash'
import type { Part } from '@/shared/parts'

const text = (t: string): Part => ({ type: 'text', text: t })
const image = (id: number): Part => ({ type: 'image', attachment_id: id })

describe('joinStash', () => {
  it('grows one message rather than collecting several', () => {
    // Three sentences typed while waiting are one remark. Delivered as three they would read to
    // the model as being interrupted three times, and an interrupt would have to choose an order.
    const held = [text('first')]
    expect(joinStash(joinStash(held, [text('second')]), [text('third')]))
      .toEqual([text('first\nsecond\nthird')])
  })

  it('keeps images as their own parts, in the order they were sent', () => {
    const out = joinStash(joinStash([text('look')], [image(4)]), [text('at this')])
    expect(out).toEqual([text('look'), image(4), text('at this')])
  })

  it('starts from nothing without a leading blank line', () => {
    expect(joinStash([], [text('alone')])).toEqual([text('alone')])
  })
})
