// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AskUserCard from '@/plugins/ask-user/client/ask-user-card.vue'
import Composer from '@/client/components/composer.vue'
import ToolPartRenderer from '@/client/components/tool-part-renderer.vue'
import { buildAnsweredResult, initialAnswers } from '@/plugins/ask-user/client/answers'
import type { AskUserInput } from '@/plugins/ask-user/shared'
import { canContinueToolMessage, hasPendingToolCalls, pendingAskUserCalls } from '@/client/components/tool-part-renderer'
import type { Message } from '@/shared/models'
import { TooltipProvider } from '@/client/ui/tooltip'

const input: AskUserInput = {
  questions: [
    { id: 'framework', header: 'Framework', question: 'Choose one', type: 'single', options: [{ label: 'Vue' }, { label: 'React' }], allowOther: true },
    { id: 'features', header: 'Features', question: 'Choose many', type: 'multiple', options: [{ label: 'Tools' }, { label: 'Cache' }], allowOther: true },
    { id: 'notes', header: 'Notes', question: 'Say more', type: 'text', placeholder: 'Optional detail' },
  ],
}

function message(parts: Message['parts'], id = 20, parentId: number | null = 10): Message {
  return {
    id,
    session_id: 3,
    parent_id: parentId,
    seq: id,
    role: 'assistant',
    parts,
    provider_id: 1,
    model_id: 'model',
    usage: null,
    status: 'done',
    error: null,
    created_at: 1,
  }
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

  it('merges one Other value into choice answers without duplicating preset selections', () => {
    expect(buildAnsweredResult(input, {
      framework: 'Svelte', features: ['Cache'], notes: 'Ship it',
    }, { features: 'Solid' })).toEqual({
      status: 'answered',
      answers: [
        { id: 'framework', value: 'Svelte' },
        { id: 'features', value: ['Cache', 'Solid'] },
        { id: 'notes', value: 'Ship it' },
      ],
    })
  })

  it('renders an Other input for choice questions unless the Agent disables it', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({ render: () => h(AskUserCard, {
      call: { type: 'tool_call', id: 'call-1', name: 'ask_user', args: input },
      result: null,
      canContinue: false,
    }) })
    app.mount(root)
    expect(root.querySelectorAll('input[placeholder="其他…"]')).toHaveLength(2)
    app.unmount()

    const strictInput: AskUserInput = {
      questions: [{
        id: 'framework', header: 'Framework', question: 'Choose one', type: 'single',
        options: [{ label: 'Vue' }, { label: 'React' }], allowOther: false,
      }],
    }
    const strict = createApp({ render: () => h(AskUserCard, {
      call: { type: 'tool_call', id: 'call-2', name: 'ask_user', args: strictInput },
      result: null,
      canContinue: false,
    }) })
    strict.mount(root)
    expect(root.querySelector('input[placeholder="其他…"]')).toBeNull()
    strict.unmount()
    root.remove()
  })

  it('focuses the active answer so Enter can advance or submit without an extra click', async () => {
    const respond = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const oneQuestion: AskUserInput = { questions: [input.questions[0]!] }
    const app = createApp({ render: () => h(AskUserCard, {
      call: { type: 'tool_call', id: 'call-enter', name: 'ask_user', args: oneQuestion },
      result: null,
      canContinue: false,
      onRespond: respond,
    }) })
    app.mount(root)
    await nextTick()
    const first = root.querySelector<HTMLInputElement>('input[type="radio"]')!
    expect(document.activeElement).toBe(first)
    first.click()
    await nextTick()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await nextTick()
    expect(respond).toHaveBeenCalledOnce()
    app.unmount()
    root.remove()
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

  it('detects unmatched calls and only permits recovery after every call is answered', () => {
    const first = { type: 'tool_call' as const, id: 'one', name: 'ask_user', args: input }
    const second = { type: 'tool_call' as const, id: 'two', name: 'ask_user', args: input }
    const answeredOne = { type: 'tool_result' as const, call_id: 'one', name: 'ask_user', content: { status: 'answered', answers: [] } }
    const answeredTwo = { type: 'tool_result' as const, call_id: 'two', name: 'ask_user', content: { status: 'answered', answers: [] } }
    const pending = message([first, second, answeredOne])
    expect(hasPendingToolCalls([pending])).toBe(true)
    expect(canContinueToolMessage(pending, [pending], pending.id)).toBe(false)

    const answered = message([first, second, answeredOne, answeredTwo])
    expect(hasPendingToolCalls([answered])).toBe(false)
    expect(canContinueToolMessage(answered, [answered], answered.id)).toBe(true)
  })

  it('only blocks on valid interactive ask_user calls in completed messages', () => {
    const valid = { type: 'tool_call' as const, id: 'valid', name: 'ask_user', args: input }
    expect(hasPendingToolCalls([message([valid])])).toBe(true)
    expect(hasPendingToolCalls([{ ...message([valid]), status: 'error' }])).toBe(false)
    expect(hasPendingToolCalls([{ ...message([valid]), status: 'aborted' }])).toBe(false)
    expect(hasPendingToolCalls([message([{ ...valid, name: 'unknown_tool' }])])).toBe(false)
    expect(hasPendingToolCalls([message([{ ...valid, args: { questions: [] } }])])).toBe(false)
  })

  it('selects only unresolved ask_user calls from the current Session head for the composer', () => {
    const first = { type: 'tool_call' as const, id: 'first', name: 'ask_user', args: input }
    const second = { type: 'tool_call' as const, id: 'second', name: 'ask_user', args: input }
    const old = message([{ ...first, id: 'old' }], 19)
    const head = message([
      first,
      { type: 'tool_result', call_id: 'first', name: 'ask_user', content: { status: 'answered' } },
      second,
    ])
    expect(pendingAskUserCalls([old, head], head.id)).toEqual([{ messageId: head.id, call: second }])
    expect(pendingAskUserCalls([old, head], old.id)).toEqual([{ messageId: old.id, call: { ...first, id: 'old' } }])
  })

  it('replaces the composer input without discarding its draft', async () => {
    const replaced = ref(false)
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({
      render: () => h(TooltipProvider, null, { default: () => h(Composer, {
        streaming: false, connected: true, canSend: true, replaced: replaced.value,
      }, { replacement: () => h('div', { 'data-test': 'questionnaire-slot' }, 'questionnaire') }) }),
    })
    app.mount(root)
    const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.value = '保留这段草稿'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    replaced.value = true
    await nextTick()
    expect(root.querySelector('textarea')).toBeNull()
    expect(root.querySelector('[data-test="questionnaire-slot"]')).not.toBeNull()
    replaced.value = false
    await nextTick()
    expect(root.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('保留这段草稿')
    app.unmount()
    root.remove()
  })

  it('shows a compact message placeholder instead of duplicating pending choices', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const app = createApp({ render: () => h(ToolPartRenderer, {
      messageId: 20,
      call: { type: 'tool_call', id: 'call-1', name: 'ask_user', args: input },
      result: null,
      canContinue: false,
      placement: 'message',
      deferPending: true,
    }) })
    app.use(createPinia())
    app.provide('clientPluginHost', null)
    app.mount(root)
    await nextTick()
    expect(root.textContent).toContain('请在下方回答')
    expect(root.textContent).not.toContain('Choose one')
    app.unmount()

    const historical = createApp({ render: () => h(ToolPartRenderer, {
      messageId: 20,
      call: { type: 'tool_call', id: 'call-1', name: 'ask_user', args: input },
      result: null,
      canContinue: false,
      placement: 'message',
      deferPending: false,
    }) })
    historical.use(createPinia())
    historical.provide('clientPluginHost', null)
    historical.mount(root)
    await nextTick()
    expect(root.textContent).not.toContain('请在下方回答')
    historical.unmount()
    root.remove()
  })

  it('hides recovery for cancellation, a non-head message, or an existing assistant child', () => {
    const call = { type: 'tool_call' as const, id: 'one', name: 'ask_user', args: input }
    const cancelled = message([call, { type: 'tool_result', call_id: 'one', name: 'ask_user', content: { status: 'cancelled' } }])
    expect(canContinueToolMessage(cancelled, [cancelled], cancelled.id)).toBe(false)

    const answered = message([call, { type: 'tool_result', call_id: 'one', name: 'ask_user', content: { status: 'answered' } }])
    expect(canContinueToolMessage(answered, [answered], 99)).toBe(false)
    const child = message([{ type: 'text', text: 'continued' }], 21, answered.id)
    expect(canContinueToolMessage(answered, [answered, child], answered.id)).toBe(false)
  })

})

afterEach(() => { document.body.innerHTML = '' })
