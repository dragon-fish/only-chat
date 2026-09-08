import { describe, expect, it } from 'vitest'
import { asSchema } from '@ai-sdk/provider-utils'
import { repairAskUserInput } from '@/plugins/ask-user/server/repair'
import { AskUserInputSchema } from '@/plugins/ask-user/shared'

const validInput = JSON.stringify({
  questions: [{
    id: 'framework', header: '框架', question: '选择框架', type: 'single',
    options: [{ label: 'Vue' }, { label: 'React' }],
  }],
})

describe('ask_user tool input repair', () => {
  it('accepts the first valid repair within three attempts', async () => {
    const replies = ['not json', '{"questions":[]}', validInput]
    let calls = 0
    const repaired = await repairAskUserInput({
      input: '{"questions":[{"type":"choice"}]}',
      error: 'Invalid discriminator value',
      schema: { type: 'object' },
      generate: async () => replies[calls++]!,
    })

    expect(repaired).toBe(JSON.stringify({
      questions: [{
        id: 'framework', header: '框架', question: '选择框架', required: false, type: 'single',
        options: [{ label: 'Vue' }, { label: 'React' }], allowOther: true,
      }],
    }))
    expect(calls).toBe(3)
  })

  it('stops after three invalid repairs', async () => {
    let calls = 0
    const repaired = await repairAskUserInput({
      input: '{"questions":[]}',
      error: 'Too few questions',
      schema: { type: 'object' },
      generate: async () => {
        calls++
        return '{"questions":[]}'
      },
    })

    expect(repaired).toBeNull()
    expect(calls).toBe(3)
  })

  it('publishes one flat question shape to language models', async () => {
    const schema = await asSchema(AskUserInputSchema).jsonSchema
    const questions = schema.properties?.questions as { items?: Record<string, unknown> }
    expect(questions.items).toMatchObject({
      type: 'object',
      properties: { type: { type: 'string', enum: ['single', 'multiple', 'text'] } },
    })
    expect(questions.items).not.toHaveProperty('anyOf')
    expect(questions.items).not.toHaveProperty('oneOf')
  })
})
