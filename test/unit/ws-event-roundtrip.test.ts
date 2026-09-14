import { describe, expect, it } from 'vitest'
import { encodeEvent, WsEventSchema, type WsEvent } from '@/shared/ws'

/**
 * Every event the hub can emit has to survive the client's own parser.
 *
 * The client drops what it cannot parse with a console warning, so a field the sender leaves empty
 * and the schema insists on is invisible on both sides: the server believes it broadcast, the
 * client never hears, and nothing fails. That is exactly how a withdrawal stopped returning to the
 * composer while every other test stayed green.
 */
function roundTrip(event: WsEvent) {
  return WsEventSchema.safeParse(JSON.parse(encodeEvent(event)))
}

describe('ws events survive the client parser', () => {
  it('accepts a withdrawal that hands the stash back', () => {
    const parsed = roundTrip({
      type: 'interject.withdrawn', conversation_id: 1, parts: [{ type: 'text', text: '算了' }],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts a withdrawal that lost the race and has nothing to hand back', () => {
    expect(roundTrip({ type: 'interject.withdrawn', conversation_id: 1, parts: [] }).success).toBe(true)
  })

  it('accepts a stash update in both directions', () => {
    expect(roundTrip({ type: 'interject.stash', conversation_id: 1, parts: [] }).success).toBe(true)
    expect(roundTrip({
      type: 'interject.stash', conversation_id: 1, parts: [{ type: 'image', attachment_id: 3 }],
    }).success).toBe(true)
  })

  it('carries an interjection part on a message update', () => {
    const parsed = roundTrip({
      type: 'message.part',
      message_id: 2,
      part_index: 0,
      part: { type: 'interjection', parts: [{ type: 'text', text: '等一下' }] },
    })
    expect(parsed.success).toBe(true)
  })
})
