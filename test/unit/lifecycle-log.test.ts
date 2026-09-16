import { afterEach, describe, expect, it, vi } from 'vitest'
import { logLifecycle } from '@/server/plugins/hub/lifecycle-log'

function captured(run: () => void): unknown[] {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
  run()
  const calls = spy.mock.calls.map(call => call[0])
  spy.mockRestore()
  return calls
}

afterEach(() => vi.restoreAllMocks())

describe('lifecycle logging', () => {
  it('emits one structured object, not a pre-encoded string', () => {
    const [entry] = captured(() => logLifecycle('tool.called', {
      conversationId: 38, messageId: 300, toolId: 'write_file', bytes: 24797,
    }))
    // A string would reach the log platform as an opaque blob: nothing to filter a conversation by.
    expect(typeof entry).toBe('object')
    expect(entry).toMatchObject({
      event: 'chat.tool.called', conversationId: 38, messageId: 300, toolId: 'write_file', bytes: 24797,
    })
  })

  it('carries a readable message, because that is the only column a log list shows', () => {
    const [entry] = captured(() => logLifecycle('tool.called', {
      conversationId: 38, messageId: 300, toolId: 'write_file', bytes: 24797,
    }))
    expect((entry as { message: string }).message)
      .toBe('[chat.tool.called] conversation_id=38 message_id=300 tool_id=write_file bytes=24797')
  })

  it('leaves absent fields out of the line rather than printing undefined', () => {
    const [entry] = captured(() => logLifecycle('generation.finished', { conversationId: 7, status: 'done' }))
    expect((entry as { message: string }).message).toBe('[chat.generation.finished] conversation_id=7 status=done')
  })

  it('rounds durations, which are read by humans and not by a stopwatch', () => {
    const [entry] = captured(() => logLifecycle('reasoning.ended', { conversationId: 7, durationMs: 1234.5678 }))
    expect(entry).toMatchObject({ durationMs: 1235 })
    expect((entry as { message: string }).message).toContain('duration_ms=1235')
  })
})
