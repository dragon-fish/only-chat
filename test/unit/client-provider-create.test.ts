// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'vue-sonner'
import ProviderCreateDialog from '@/client/components/provider-create-dialog.vue'
import { api } from '@/client/lib/api'
import { provider } from './provider-fixtures'
import type { CatalogProviderSummary, CodexOAuthPollResponse, CodexOAuthStartResponse } from '@/shared/api'

let cleanup = () => {}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.innerHTML = '' })

const oauthApi = api as typeof api & {
  startCodexOAuth: () => Promise<CodexOAuthStartResponse>
  pollCodexOAuth: (flowId: string) => Promise<CodexOAuthPollResponse>
  cancelCodexOAuth: (flowId: string) => Promise<void>
}
const oauthGrant = (): CodexOAuthStartResponse => ({
  flow_id: '6b23e34a-8f0d-4c7e-a3d1-0e7d9ca1cd8b',
  verification_url: 'https://auth.openai.com/codex/device',
  user_code: 'ABCD-EFGH',
  expires_at: Date.now() + 10_000,
  poll_interval_ms: 1_000,
})

function mockOAuthApi() {
  oauthApi.startCodexOAuth = vi.fn().mockResolvedValue(oauthGrant())
  oauthApi.pollCodexOAuth = vi.fn().mockResolvedValue({ status: 'pending', next_poll_at: Date.now() + 1_000 })
  oauthApi.cancelCodexOAuth = vi.fn().mockResolvedValue(undefined)
  return oauthApi
}

async function type(selector: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function mountDialog(entries: CatalogProviderSummary[] = [{ id: 'acme', name: 'Acme', api: 'https://acme.test/v1', npm: '@ai-sdk/openai' }, { id: 'lab', name: 'Lab', api: 'https://lab.test/v1', npm: '@ai-sdk/anthropic' }]) {
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
  it('starts Codex device login without revealing or editing a custom-provider draft', async () => {
    const oauth = mockOAuthApi()
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.waitFor(() => expect(oauth.startCodexOAuth).toHaveBeenCalledOnce())

    expect(document.querySelector('[data-codex-user-code]')?.textContent).toContain('ABCD-EFGH')
    expect(document.querySelector('[data-slot="progress"]')?.getAttribute('aria-label')).toBe('设备代码有效期')
    expect(document.querySelector('[data-provider-key]')).toBeNull()
    expect(document.querySelector('[data-interface-url]')).toBeNull()
  })

  it('creates the provider after a completed Codex device poll', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    oauth.pollCodexOAuth = vi.fn().mockResolvedValue({ status: 'complete', provider })
    const { created } = await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)

    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(provider))
    vi.useRealTimers()
  })

  it.each(['success', 'rejection'] as const)('copies the device code with accessible feedback on clipboard %s', async outcome => {
    mockOAuthApi()
    const write = vi.spyOn(navigator.clipboard, 'writeText')
    if (outcome === 'success') write.mockResolvedValue()
    else write.mockRejectedValue(new Error('private-device-auth ABCD-EFGH clipboard denied'))
    const succeeded = vi.spyOn(toast, 'success').mockReturnValue('toast-success')
    const failed = vi.spyOn(toast, 'error').mockReturnValue('toast-error')
    await mountDialog()
    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-codex-user-code]')).not.toBeNull())
    const copy = document.querySelector<HTMLButtonElement>('button[data-codex-copy-code]')
    expect(copy).not.toBeNull()
    expect(copy!.textContent?.trim() || copy!.getAttribute('aria-label')).toBeTruthy()
    expect(copy!.disabled).toBe(false)
    expect(copy!.tabIndex).toBe(0)
    copy!.focus()
    expect(document.activeElement).toBe(copy)
    copy!.click()

    await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith('ABCD-EFGH'))
    await vi.waitFor(() => expect(outcome === 'success' ? succeeded : failed).toHaveBeenCalledOnce())
    expect(outcome === 'success' ? failed : succeeded).not.toHaveBeenCalled()
    expect(JSON.stringify([succeeded.mock.calls, failed.mock.calls])).not.toMatch(/private-device-auth|ABCD-EFGH/)
  })

  it('waits until the server-specified time before each Codex poll', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    oauth.startCodexOAuth = vi.fn().mockResolvedValue({ ...oauthGrant(), expires_at: Date.now() + 20_000 })
    oauth.pollCodexOAuth = vi.fn().mockImplementation(async () => ({ status: 'pending' as const, next_poll_at: Date.now() + 5_000 }))
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(oauth.pollCodexOAuth).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('cancels a waiting Codex flow exactly once when closed', async () => {
    const oauth = mockOAuthApi()
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-codex-user-code]')).not.toBeNull())
    const close = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-close"]')].at(-1)!
    close.click()
    close.click()

    await vi.waitFor(() => expect(oauth.cancelCodexOAuth).toHaveBeenCalledOnce())
    expect(oauth.cancelCodexOAuth).toHaveBeenCalledWith('6b23e34a-8f0d-4c7e-a3d1-0e7d9ca1cd8b')
  })

  it('marks a waiting Codex flow expired when its device code expires', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    oauth.pollCodexOAuth = vi.fn().mockImplementation(async () => ({ status: 'pending' as const, next_poll_at: Date.now() + 10_000 }))
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(document.querySelector('[data-codex-expired]')).not.toBeNull()
    expect(document.querySelector('[data-codex-expired]')?.getAttribute('role')).toBe('status')
    expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()
    expect(oauth.cancelCodexOAuth).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('cancels a waiting Codex flow after a poll transport failure', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    oauth.pollCodexOAuth = vi.fn().mockRejectedValue(new Error('Network unavailable'))
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable'))
    expect(oauth.cancelCodexOAuth).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it.each(['complete', 'pending'] as const)('waits for an in-flight Codex poll at expiry before handling %s', async status => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    let resolvePoll!: (result: CodexOAuthPollResponse) => void
    oauth.pollCodexOAuth = vi.fn().mockImplementation(() => new Promise<CodexOAuthPollResponse>(resolve => { resolvePoll = resolve }))
    const { created } = await mountDialog()
    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(39_000)
    expect(oauth.cancelCodexOAuth).not.toHaveBeenCalled()
    expect(document.querySelector('[data-codex-expired]')).toBeNull()
    resolvePoll(status === 'complete' ? { status, provider } : { status, next_poll_at: Date.now() + 5_000 })
    await vi.advanceTimersByTimeAsync(0)

    if (status === 'complete') {
      expect(created).toHaveBeenCalledExactlyOnceWith(provider)
      expect(oauth.cancelCodexOAuth).not.toHaveBeenCalled()
    } else {
      expect(created).not.toHaveBeenCalled()
      expect(document.querySelector('[data-codex-expired]')).not.toBeNull()
      expect(oauth.cancelCodexOAuth).toHaveBeenCalledExactlyOnceWith(oauthGrant().flow_id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()
    }
  })

  it('ignores a late completed poll after its Codex dialog is closed and replaced', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    let resolvePoll!: (result: CodexOAuthPollResponse) => void
    oauth.pollCodexOAuth = vi.fn().mockImplementation(() => new Promise<CodexOAuthPollResponse>(resolve => { resolvePoll = resolve }))
    const { created } = await mountDialog()
    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.advanceTimersByTimeAsync(1_000)
    const resolveOldPoll = resolvePoll
    ;[...document.querySelectorAll<HTMLButtonElement>('[data-slot="dialog-close"]')].at(-1)!.click()
    await vi.advanceTimersByTimeAsync(0)
    const replacement = { ...oauthGrant(), flow_id: 'b7044b37-1c3e-4914-833d-530c8d1eb999', user_code: 'NEXT-CODE' }
    oauth.startCodexOAuth = vi.fn().mockResolvedValue(replacement)
    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.advanceTimersByTimeAsync(0)
    resolveOldPoll({ status: 'complete', provider })
    await vi.advanceTimersByTimeAsync(0)

    expect(created).not.toHaveBeenCalled()
    expect(document.querySelector('[data-codex-user-code]')?.textContent).toContain('NEXT-CODE')
    expect(oauth.cancelCodexOAuth).toHaveBeenCalledExactlyOnceWith(oauthGrant().flow_id)
  })

  it('keeps expiry terminal when an in-flight Codex poll rejects afterwards', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    let rejectPoll: (error: Error) => void = () => undefined
    oauth.pollCodexOAuth = vi.fn().mockImplementation(() => new Promise<CodexOAuthPollResponse>((_, reject) => { rejectPoll = reject }))
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(oauth.pollCodexOAuth).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(9_000)
    rejectPoll(new Error('Network unavailable'))
    await vi.advanceTimersByTimeAsync(0)

    expect(document.querySelector('[data-codex-expired]')).not.toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(oauth.cancelCodexOAuth).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('shows a failed device authorization without cancelling a terminal flow', async () => {
    vi.useFakeTimers()
    const oauth = mockOAuthApi()
    oauth.pollCodexOAuth = vi.fn().mockResolvedValue({ status: 'failed', error: 'Authorization denied' })
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1_000)

    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Authorization denied'))
    expect(oauth.cancelCodexOAuth).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('restarts device authorization after a transient request failure', async () => {
    const oauth = mockOAuthApi()
    oauth.startCodexOAuth = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(oauthGrant())
    await mountDialog()

    document.querySelector<HTMLButtonElement>('[data-add-codex]')!.click()
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable'))
    ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === '重试')!.click()

    await vi.waitFor(() => expect(oauth.startCodexOAuth).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(document.querySelector('[data-codex-user-code]')).not.toBeNull())
  })

  it.each([
    ['@ai-sdk/openai', 'responses'], ['@ai-sdk/anthropic', 'anthropic'], ['@ai-sdk/openai-compatible', 'chat-completions'],
  ])('prefills the recognized %s interface format', async (npm, protocol) => {
    const { create } = await mountDialog([{ id: 'known', name: 'Known provider', api: 'https://known.test/v1', npm }])
    document.querySelector<HTMLElement>('[data-slot="command-item"]')!.click()
    await vi.waitFor(() => expect(document.querySelector(`[data-protocol="${protocol}"]`)).not.toBeNull())
    document.querySelector('#create-provider-name')!.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ default_protocol: protocol, interfaces: [{ protocol, base_url: 'https://known.test/v1' }] })
  })

  it.each([undefined, '@unrecognized/sdk'])('requires explicit interface selection for catalog npm=%s', async npm => {
    const { create } = await mountDialog([{ id: 'unknown', name: 'Unknown SDK', api: 'https://unknown.test/v1', npm }])
    document.querySelector<HTMLElement>('[data-slot="command-item"]')!.click()
    await vi.waitFor(() => expect(document.querySelector('#create-provider-name')).not.toBeNull())
    expect(document.querySelector('[data-interface-url]')).toBeNull()
    const form = document.querySelector('#create-provider-name')!.closest('form')!
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(create).not.toHaveBeenCalled()
    document.querySelector('[aria-label="添加接口"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')).not.toBeNull())
    ;[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Anthropic Messages')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[data-protocol="anthropic"]')?.value).toBe('https://unknown.test/v1'))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0]?.[0]).toMatchObject({ default_protocol: 'anthropic', models_dev_provider: { source: 'manual', provider_id: 'unknown' } })
  })

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
