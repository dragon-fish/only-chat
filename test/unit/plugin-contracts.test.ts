import { describe, expect, it } from 'vitest'
import {
  AskUserInputSchema,
  AskUserResultSchema,
  validateAskUserResult,
} from '@/plugins/ask-user/shared'

const singleQuestion = {
  id: 'framework', header: 'Framework', question: 'Which framework?', type: 'single' as const,
  options: [{ label: 'Vue' }, { label: 'React' }],
}

describe('ask_user shared contract', () => {
  it('accepts one to three strictly shaped questions', () => {
    expect(AskUserInputSchema.parse({ questions: [singleQuestion] })).toEqual({
      questions: [{ ...singleQuestion, allowOther: true }],
    })
    expect(AskUserInputSchema.parse({ questions: [{ ...singleQuestion, allowOther: false }] }))
      .toMatchObject({ questions: [{ allowOther: false }] })
    expect(AskUserInputSchema.parse({ questions: [singleQuestion, { ...singleQuestion, id: 'two' }, { ...singleQuestion, id: 'three' }] }).questions).toHaveLength(3)
    expect(() => AskUserInputSchema.parse({ questions: [] })).toThrow()
    expect(() => AskUserInputSchema.parse({ questions: [singleQuestion, { ...singleQuestion, id: 'two' }, { ...singleQuestion, id: 'three' }, { ...singleQuestion, id: 'four' }] })).toThrow()
  })

  it('requires unique IDs and valid choice shapes', () => {
    expect(() => AskUserInputSchema.parse({ questions: [singleQuestion, singleQuestion] })).toThrow(/unique/i)
    expect(() => AskUserInputSchema.parse({ questions: [{ ...singleQuestion, options: [{ label: 'only' }] }] })).toThrow()
    expect(() => AskUserInputSchema.parse({ questions: [{ ...singleQuestion, options: [{ label: 'Vue' }, { label: 'Vue' }] }] })).toThrow(/unique/i)
    expect(() => AskUserInputSchema.parse({ questions: [{ id: 'notes', header: 'Notes', question: 'Anything else?', type: 'text', options: [] }] })).toThrow()
    expect(AskUserInputSchema.parse({ questions: [{ id: 'notes', header: 'Notes', question: 'Anything else?', type: 'text', placeholder: 'Optional' }] })).toMatchObject({ questions: [{ type: 'text' }] })
  })

  it('validates answered values against their original question type and options', () => {
    const input = AskUserInputSchema.parse({ questions: [
      singleQuestion,
      { id: 'features', header: 'Features', question: 'Pick features', type: 'multiple' as const, options: [{ label: 'Cache' }, { label: 'Tools' }] },
      { id: 'notes', header: 'Notes', question: 'Anything else?', type: 'text' as const },
    ] })
    const answer = AskUserResultSchema.parse({ status: 'answered', answers: [
      { id: 'framework', value: 'Vue' }, { id: 'features', value: ['Cache', 'Tools'] }, { id: 'notes', value: 'Keep it small' },
    ] })
    expect(validateAskUserResult(input, answer)).toEqual(answer)
    expect(() => validateAskUserResult(input, { status: 'answered', answers: [{ id: 'framework', value: ['Vue'] }] })).toThrow()
    expect(() => validateAskUserResult(input, { status: 'answered', answers: [{ id: 'features', value: 'Cache' }] })).toThrow()
    expect(() => validateAskUserResult(input, { status: 'answered', answers: [{ id: 'framework', value: 'Svelte' }] })).toThrow()
  })

  it('accepts at most one custom choice only when that question allows Other', () => {
    const single = AskUserInputSchema.parse({ questions: [singleQuestion] })
    expect(validateAskUserResult(single, {
      status: 'answered', answers: [{ id: 'framework', value: 'Svelte' }],
    })).toMatchObject({ answers: [{ value: 'Svelte' }] })

    const strict = AskUserInputSchema.parse({ questions: [{ ...singleQuestion, allowOther: false }] })
    expect(() => validateAskUserResult(strict, {
      status: 'answered', answers: [{ id: 'framework', value: 'Svelte' }],
    })).toThrow(/invalid option/i)

    const multiple = AskUserInputSchema.parse({ questions: [{
      ...singleQuestion, id: 'features', type: 'multiple',
    }] })
    expect(validateAskUserResult(multiple, {
      status: 'answered', answers: [{ id: 'features', value: ['Vue', 'Svelte'] }],
    })).toMatchObject({ answers: [{ value: ['Vue', 'Svelte'] }] })
    expect(() => validateAskUserResult(multiple, {
      status: 'answered', answers: [{ id: 'features', value: ['Svelte', 'Solid'] }],
    })).toThrow(/custom option/i)
  })

  it('accepts a terminal cancelled result', () => {
    expect(AskUserResultSchema.parse({ status: 'cancelled', message: '用户选择了取消回答' })).toMatchObject({ status: 'cancelled' })
  })
})
