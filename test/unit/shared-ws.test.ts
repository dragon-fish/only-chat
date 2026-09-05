import { describe, expect, it } from 'vitest'
import { encodeEvent, parseCommand, WsEventSchema } from '@/shared/ws'

describe('ws protocol', () => {
  it('parses a send command with a new session', () => {
    const cmd = parseCommand(JSON.stringify({
      type: 'send', request_id: 'r1', session_id: null, parent_id: null,
      parts: [{ type: 'text', text: 'hi' }], provider_id: 1, model_id: 'gpt-5.1',
    }))
    expect(cmd.type).toBe('send')
    if (cmd.type === 'send') expect(cmd.session_id).toBeNull()
  })

  it('rejects a command without type', () => {
    expect(() => parseCommand('{"session_id":1}')).toThrow()
  })

  it('round-trips a delta event', () => {
    const raw = encodeEvent({ type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he' })
    expect(WsEventSchema.parse(JSON.parse(raw))).toEqual({
      type: 'message.delta', message_id: 5, part_index: 0, kind: 'text', delta: 'he',
    })
  })

  it('settings.update accepts a partial plugins map', () => {
    const cmd = parseCommand(JSON.stringify({ type: 'settings.update', settings: { plugins: { foo: true } } }))
    expect(cmd.type).toBe('settings.update')
  })
})
