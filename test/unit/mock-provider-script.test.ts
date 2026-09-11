import { describe, expect, it } from 'vitest'
import { buildMockScript } from '@/server/plugins/mock-provider/script'

function types(prompt: string): string[] {
  return buildMockScript(prompt).parts.map(part => part.type)
}

function toolCalls(prompt: string) {
  return buildMockScript(prompt).parts.filter(part => part.type === 'tool-call')
}

describe('mock provider script', () => {
  it('streams generated prose when no directive is given', () => {
    const script = buildMockScript('讲点什么')
    expect(script.parts[0]).toEqual({ type: 'stream-start', warnings: [] })
    expect(types('讲点什么')).toContain('text-delta')
    expect(types('讲点什么')).not.toContain('tool-call')
    expect(script.parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
  })

  it('emits one tool call and finishes with tool-calls', () => {
    const calls = toolCalls('/tool_call ask_user {"questions":[]}')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolName: 'ask_user', input: '{"questions":[]}' })
    expect(buildMockScript('/tool_call ask_user {}').parts.at(-1))
      .toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } })
  })

  it('emits several tool calls from one directive, reproducing parallel calls', () => {
    const calls = toolCalls('/parallel [{"name":"ask_user","args":{"a":1}},{"name":"ask_user","args":{"b":2}}]')
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.toolName)).toEqual(['ask_user', 'ask_user'])
    // Distinct ids, or the hub would treat the second call as a duplicate of the first.
    expect(new Set(calls.map(call => call.toolCallId)).size).toBe(2)
  })

  it('emits reasoning before the text', () => {
    const parts = types('/reasoning 想一想')
    expect(parts.indexOf('reasoning-delta')).toBeGreaterThan(-1)
    expect(parts.indexOf('reasoning-end')).toBeLessThan(parts.indexOf('text-start'))
  })

  it('reports a provider failure', () => {
    const parts = buildMockScript('/error 上游炸了').parts
    expect(parts.some(part => part.type === 'error')).toBe(true)
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'error' } })
  })

  it('carries a chunk delay only when asked to be slow', () => {
    expect(buildMockScript('随便说').delayMs).toBe(0)
    expect(buildMockScript('/slow 250').delayMs).toBe(250)
  })

  it('answers in prose once the turn already ran its tools', () => {
    // The hub loops while the model emits tool calls. Without this the same directive would be
    // replayed on every step, up to the step cap.
    const directive = '/tool_call ask_user {\'questions\':[]}'.replace(/\'/g, String.fromCharCode(34))
    expect(toolCalls(directive)).toHaveLength(1)
    const after = buildMockScript(directive, { toolsAlreadyRan: true })
    expect(after.parts.some(part => part.type === 'tool-call')).toBe(false)
    expect(after.parts.map(part => part.type)).toContain('text-delta')
    expect(after.parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
  })

  it('falls back to prose when a directive is malformed rather than throwing', () => {
    expect(() => buildMockScript('/tool_call ask_user {not json}')).not.toThrow()
    expect(types('/tool_call ask_user {not json}')).toContain('text-delta')
    expect(types('/nope whatever')).toContain('text-delta')
  })
})
