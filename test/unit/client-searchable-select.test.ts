// @vitest-environment happy-dom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SearchableSelect from '@/client/components/searchable-select.vue'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

async function mountSelect() {
  const value = ref('')
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(SearchableSelect, {
      modelValue: value.value,
      'onUpdate:modelValue': next => { value.value = next },
      placeholder: '选择模型',
      searchPlaceholder: '搜索模型…',
      options: [
        { value: '', label: '不使用' },
        { value: '1:alpha', label: 'Alpha Chat', description: 'Vendor A · alpha-raw-id' },
        { value: '2:beta', label: 'Beta Vision', description: 'Vendor B · beta-vision-id' },
      ],
    }),
  })
  app.mount(host)
  cleanup = () => app.unmount()
  await nextTick()
  return { host, value }
}

describe('SearchableSelect', () => {
  it('filters by option details and commits the selected value', async () => {
    const { host, value } = await mountSelect()
    const trigger = host.querySelector<HTMLButtonElement>('button')!
    expect(trigger.getAttribute('aria-label')).toBe('选择模型')
    trigger.click()
    await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(3))

    const input = document.querySelector<HTMLInputElement>('[data-slot="combobox-input"]')!
    input.value = 'beta-vision-id'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect([...document.querySelectorAll('[role="option"]')].filter(option => !option.hasAttribute('data-hidden'))).toHaveLength(1))

    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('Beta Vision'))!.click()
    await vi.waitFor(() => expect(value.value).toBe('2:beta'))
    expect(host.querySelector('button')?.textContent).toContain('Beta Vision')
  })
})
