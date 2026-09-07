// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProviderCreateDialog from '@/client/components/provider-create-dialog.vue'
import { api } from '@/client/lib/api'
import { provider } from './provider-fixtures'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.innerHTML = '' })

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function mountDialog() {
  const entries = [{ id: 'acme', name: 'Acme', api: 'https://acme.test/v1', npm: '@ai-sdk/openai' }, { id: 'lab', name: 'Lab', api: 'https://lab.test/v1', npm: '@ai-sdk/anthropic' }]
  vi.spyOn(api, 'catalogProviders').mockImplementation(async query => entries.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(query?.toLowerCase() ?? '')))
  const created = vi.fn()
  const create = vi.spyOn(api, 'createProvider').mockResolvedValue(provider)
  document.body.innerHTML = '<div id="host"></div>'
  const app = createApp(ProviderCreateDialog, { open: true, onCreated: created })
  app.mount('#host')
  cleanup = () => app.unmount()
  await vi.waitFor(() => expect(document.querySelector('[data-slot="command-item"]')).not.toBeNull())
  return { create, created }
}

describe('provider creation', () => {
  it('searches catalog providers and prefills a manually associated interface without importing models', async () => {
    const { create, created } = await mountDialog()
    await type('[data-slot="command-input"]', 'acme')
    await vi.waitFor(() => expect(document.querySelectorAll('[data-slot="command-item"]')).toHaveLength(1))
    document.querySelector<HTMLElement>('[data-slot="command-item"]')!.click()
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('#create-provider-name')?.value).toBe('Acme'))
    expect(document.querySelector<HTMLInputElement>('[data-interface-url]')?.value).toBe('https://acme.test/v1')
    document.querySelector('#create-provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(provider))
    expect(create.mock.calls[0]?.[0]).toMatchObject({ name: 'Acme', default_protocol: 'responses', models_dev_provider: { source: 'manual', provider_id: 'acme' }, interfaces: [{ protocol: 'responses', base_url: 'https://acme.test/v1', native_files: false }] })
  })

  it('creates a custom provider with endpoint association and keeps its draft after an error', async () => {
    const { create, created } = await mountDialog()
    create.mockRejectedValueOnce(new Error('offline'))
    ;[...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '自定义供应商')!.click()
    await nextTick()
    await type('#create-provider-name', 'My gateway')
    await type('[data-interface-url]', 'https://custom.test/v1')
    const submit = () => document.querySelector('#create-provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    submit()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline'))
    expect(document.querySelector<HTMLInputElement>('#create-provider-name')?.value).toBe('My gateway')
    submit()
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(provider))
    expect(create.mock.calls[1]?.[0]).toMatchObject({ name: 'My gateway', models_dev_provider: { source: 'endpoint' }, default_protocol: 'chat-completions' })
  })
})
