// @vitest-environment happy-dom
import { createApp, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import AskUserCard from '@/plugins/ask-user/client/ask-user-card.vue'
import { buildAnsweredResult, initialAnswers } from '@/plugins/ask-user/client/answers'
import type { AskUserInput } from '@/plugins/ask-user/shared'

const input: AskUserInput = {
  questions: [
    { id: 'framework', header: 'Framework', question: 'Choose one', type: 'single', options: [{ label: 'Vue' }, { label: 'React' }] },
    { id: 'features', header: 'Features', question: 'Choose many', type: 'multiple', options: [{ label: 'Tools' }, { label: 'Cache' }] },
    { id: 'notes', header: 'Notes', question: 'Say more', type: 'text', placeholder: 'Optional detail' },
  ],
}

describe('ask_user answer serialization', () => {
  it('initializes values according to each question type', () => {
    expect(initialAnswers(input)).toEqual({ framework: '', features: [], notes: '' })
  })

  it('serializes all answers in the original question order', () => {
    expect(buildAnsweredResult(input, { notes: 'Ship it', features: ['Cache', 'Tools'], framework: 'Vue' })).toEqual({
      status: 'answered',
      answers: [
        { id: 'framework', value: 'Vue' },
        { id: 'features', value: ['Cache', 'Tools'] },
        { id: 'notes', value: 'Ship it' },
      ],
    })
  })

  it('rejects missing or type-invalid local answers before sending', () => {
    expect(() => buildAnsweredResult(input, { framework: 'Vue', features: [], notes: 'ok' })).toThrow()
    expect(() => buildAnsweredResult(input, { framework: ['Vue'], features: ['Cache'], notes: 'ok' })).toThrow()
  })

  it('renders pending and terminal states from persisted parts', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      render: () => h(AskUserCard, {
        call: { type: 'tool_call', id: 'call-1', name: 'ask_user', args: input },
        result: { type: 'tool_result', call_id: 'call-1', name: 'ask_user', content: { status: 'answered', answers: [
          { id: 'framework', value: 'Vue' },
          { id: 'features', value: ['Cache'] },
          { id: 'notes', value: 'Ship it' },
        ] } },
        canContinue: true,
      }),
    })
    app.mount(root)
    expect(root.textContent).toContain('已回答')
    expect(root.textContent).toContain('Cache')
    expect([...root.querySelectorAll('button')].some(button => button.textContent === '继续')).toBe(true)
    app.unmount()
    root.remove()
  })

  it('never offers continuation for a cancelled result', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      render: () => h(AskUserCard, {
        call: { type: 'tool_call', id: 'call-1', name: 'ask_user', args: input },
        result: { type: 'tool_result', call_id: 'call-1', name: 'ask_user', content: { status: 'cancelled', message: '用户选择了取消回答' } },
        canContinue: true,
      }),
    })
    app.mount(root)
    expect(root.textContent).toContain('用户取消了回答')
    expect([...root.querySelectorAll('button')].some(button => button.textContent === '继续')).toBe(false)
    app.unmount()
    root.remove()
  })

})

afterEach(() => { document.body.innerHTML = '' })
