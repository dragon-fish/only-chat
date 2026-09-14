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

  it('runs the steps in the order they were written', () => {
    // A step is only itself: /reasoning stopped bundling a paragraph once /content existed to ask
    // for one, which is what lets a macro put them in either order.
    const parts = types('/reasoning 想一想\n/content 说一说')
    expect(parts.indexOf('reasoning-end')).toBeLessThan(parts.indexOf('text-start'))
    expect(types('/reasoning 想一想')).not.toContain('text-delta')
  })

  it('reports a provider failure', () => {
    const parts = buildMockScript('/error 上游炸了').parts
    expect(parts.some(part => part.type === 'error')).toBe(true)
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'error' } })
  })

  /** The delay that actually governs a shape, ignoring the stream preamble. */
  const paceOf = (source: string, type: string) => {
    const script = buildMockScript(source)
    return script.delays[script.parts.findIndex(part => part.type === type)]
  }

  it('carries a chunk delay only when asked to be slow', () => {
    expect(paceOf('随便说', 'text-delta')).toBe(0)
    expect(paceOf('/slow 250', 'text-delta')).toBe(250)
  })

  it('answers in prose once the turn already ran its tools', () => {
    // The hub loops while the model emits tool calls. Without this the same directive would be
    // replayed on every step, up to the step cap.
    const directive = '/tool_call ask_user {\'questions\':[]}'.replace(/\'/g, String.fromCharCode(34))
    expect(toolCalls(directive)).toHaveLength(1)
    const after = buildMockScript(directive, { toolResults: 1 })
    expect(after.parts.some(part => part.type === 'tool-call')).toBe(false)
    expect(after.parts.map(part => part.type)).toContain('text-delta')
    expect(after.parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
  })

  it('falls back to prose when a directive is malformed rather than throwing', () => {
    expect(() => buildMockScript('/tool_call ask_user {not json}')).not.toThrow()
    expect(types('/tool_call ask_user {not json}')).toContain('text-delta')
    expect(types('/nope whatever')).toContain('text-delta')
  })

  it('paces any shape with @ms, not just prose', () => {
    // Streaming is the part of the UI worth watching, and it is over before the eye arrives.
    expect(paceOf('/reasoning@300 想一会儿', 'reasoning-delta')).toBe(300)
    expect(paceOf('/tool_call@120 ask_user {}', 'tool-call')).toBe(120)
    expect(paceOf('/reasoning 想一会儿', 'reasoning-delta')).toBe(0)
  })

  it('paces each step on its own, so a slow thought can precede fast prose', () => {
    const script = buildMockScript('/reasoning@300 慢慢想\n/content 快快说')
    const thought = script.delays[script.parts.findIndex(part => part.type === 'reasoning-delta')]
    const spoken = script.delays[script.parts.findIndex(part => part.type === 'text-delta')]
    expect([thought, spoken]).toEqual([300, 0])
  })

  it('streams a thought word by word, so the thinking state lasts long enough to see', () => {
    const deltas = buildMockScript('/reasoning one two three').parts
      .filter(part => part.type === 'reasoning-delta')
    expect(deltas.length).toBe(3)
  })

  describe('macros', () => {
    const MACRO = [
      '/reasoning@150 先想想',
      '/tool_call ask_user {"a":1}',
      '/content 然后说点什么',
      '/tool_call list_files {}',
      '/content 最后收个尾',
    ].join('\n')

    it('stops at the first tool call and resumes after it', () => {
      // A tool call ends the model's turn, so a macro is handed out one segment per call rather
      // than replayed from the top — which is what the step cap used to catch.
      const first = buildMockScript(MACRO, { toolResults: 0 })
      expect(first.parts.filter(part => part.type === 'tool-call')).toMatchObject([{ toolName: 'ask_user' }])
      expect(first.parts.some(part => part.type === 'reasoning-delta')).toBe(true)
      expect(first.parts.some(part => part.type === 'text-delta')).toBe(false)

      const second = buildMockScript(MACRO, { toolResults: 1 })
      expect(second.parts.filter(part => part.type === 'tool-call')).toMatchObject([{ toolName: 'list_files' }])
      expect(second.parts.some(part => part.type === 'text-delta')).toBe(true)

      const third = buildMockScript(MACRO, { toolResults: 2 })
      expect(third.parts.some(part => part.type === 'tool-call')).toBe(false)
      expect(third.parts.at(-1)).toMatchObject({ finishReason: { unified: 'stop' } })
    })

    it('answers in prose once the macro has run out of steps', () => {
      const spent = buildMockScript(MACRO, { toolResults: 9 })
      expect(spent.parts.some(part => part.type === 'tool-call')).toBe(false)
      expect(spent.parts.map(part => part.type)).toContain('text-delta')
    })

    it('reads a bare number as a word count', () => {
      const counted = buildMockScript('/content 7').parts.filter(part => part.type === 'text-delta')
      expect(counted).toHaveLength(7)
      const spoken = buildMockScript('/content 七 个 字').parts.filter(part => part.type === 'text-delta')
      expect(spoken).toHaveLength(3)
    })

    it('ignores lines that are not directives, so a macro can be commented', () => {
      const parts = types('这一行是说明\n/content 正文\n随便写点别的')
      expect(parts).toContain('text-delta')
      expect(buildMockScript('这一行是说明\n/content 正文').parts.filter(part => part.type === 'text-delta'))
        .toHaveLength(1)
    })
  })
})
