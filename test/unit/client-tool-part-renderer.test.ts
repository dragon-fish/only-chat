// @vitest-environment happy-dom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, expect, it } from 'vitest'
import ToolPartRenderer from '@/client/components/tool-part-renderer.vue'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'

afterEach(() => { document.body.innerHTML = '' })

async function render(call: ToolCallPart, result: ToolResultPart | null, settled: boolean) {
  const root = document.createElement('div')
  document.body.append(root)
  createApp({ render: () => h(ToolPartRenderer, { messageId: 1, call, result, canContinue: false, placement: 'message', settled }) })
    .use(createPinia()).mount(root)
  await nextTick()
  return root.textContent ?? ''
}

it('shows a call that ended without a result as unfinished once its message has settled', async () => {
  const call: ToolCallPart = { type: 'tool_call', id: 'c1', name: 'edit_file', args: { oldText: 'a' } }
  expect(await render(call, null, true)).toContain('edit_file 未完成')
  expect(await render(call, null, false)).not.toContain('未完成')
})

it('keeps a person-answered tool waiting past the end of its message', async () => {
  const call: ToolCallPart = { type: 'tool_call', id: 'c2', name: 'ask_user', args: { questions: [] } }
  expect(await render(call, null, true)).not.toContain('未完成')
})

it('shows a failed call as a failure with the message the model was sent', async () => {
  const call: ToolCallPart = { type: 'tool_call', id: 'c3', name: 'edit_file', args: {} }
  const failed: ToolResultPart = { type: 'tool_result', call_id: 'c3', name: 'edit_file', content: 'path: Required', is_error: true }
  const text = await render(call, failed, true)
  expect(text).toContain('edit_file 调用失败')
  expect(text).toContain('path: Required')
})
