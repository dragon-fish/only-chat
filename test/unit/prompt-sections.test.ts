import { describe, expect, it } from 'vitest'
import { renderSystemPrompt, type PromptSection } from '@/server/plugins/prompt-sections'

const order = ['alpha', 'beta', 'gamma']
const input = { toolIds: ['t'] }

describe('renderSystemPrompt', () => {
  it('appends sections after the user prompt in manifest order, whatever order they registered in', () => {
    const a: PromptSection = () => 'A'
    const c: PromptSection = () => 'C'
    const forward = renderSystemPrompt('be brief', order, new Map([['alpha', a], ['gamma', c]]), input)
    const backward = renderSystemPrompt('be brief', order, new Map([['gamma', c], ['alpha', a]]), input)
    expect(forward).toBe('be brief\n\n<plugin id="alpha">\nA\n</plugin>\n\n<plugin id="gamma">\nC\n</plugin>')
    expect(backward).toBe(forward)
  })

  it('leaves no trace of a section that has nothing to say', () => {
    const silent = new Map<string, PromptSection>([['alpha', () => undefined], ['beta', () => '']])
    expect(renderSystemPrompt('be brief', order, silent, input)).toBe('be brief')
    expect(renderSystemPrompt(null, order, silent, input)).toBeNull()
  })

  it('stands alone without a user prompt', () => {
    expect(renderSystemPrompt('', order, new Map([['beta', () => 'B']]), input)).toBe('<plugin id="beta">\nB\n</plugin>')
  })

  it('hands every section the tool set', () => {
    const section: PromptSection = ({ toolIds }) => toolIds.includes('t') ? 'on' : undefined
    expect(renderSystemPrompt(null, order, new Map([['alpha', section]]), input)).toContain('on')
    expect(renderSystemPrompt(null, order, new Map([['alpha', section]]), { toolIds: [] })).toBeNull()
  })
})
