import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildConfigControls, buildConfigPatch, initialFormValues, providerOptions, visibleControls } from '@/client/lib/plugin-config-form'
import webSearch from '@/plugins/web-search/manifest'
import type { PluginManifest } from '@/shared/plugins'

const manifest: PluginManifest = {
  id: 'tavily',
  name: 'Tavily',
  description: 'search',
  tools: [{ id: 'web_search', name: '搜索', description: '搜' }],
  configSchema: z.object({
    api_key: z.string().trim().min(1, '请填写 API Key'),
    search_depth: z.enum(['basic', 'advanced']).default('basic'),
    search_calls_per_turn: z.number().int().min(1).max(10).default(3),
  }),
  config: [
    { key: 'api_key', label: 'API Key', type: 'secret', help: 'h' },
    { key: 'search_depth', label: '深度', type: 'select', help: 'h' },
    { key: 'search_calls_per_turn', label: '每轮上限', type: 'number', help: 'h' },
  ],
}

const status = { configured: true, values: { search_depth: 'advanced' }, secrets: { api_key: true } }

describe('plugin config form derivation', () => {
  it('reads options, bounds and defaults out of the schema rather than the field declaration', () => {
    const controls = buildConfigControls(manifest, status)
    expect(controls.map(c => c.key)).toEqual(['api_key', 'search_depth', 'search_calls_per_turn'])
    expect(controls[1]).toMatchObject({ type: 'select', options: ['basic', 'advanced'], default: 'basic' })
    expect(controls[2]).toMatchObject({ type: 'number', min: 1, max: 10, default: 3 })
    expect(controls[0]).toMatchObject({ type: 'secret', required: true, configured: true })
  })

  it('seeds stored values, falls back to schema defaults, and never seeds a secret', () => {
    expect(initialFormValues(buildConfigControls(manifest, status))).toEqual({
      api_key: '',
      search_depth: 'advanced',
      search_calls_per_turn: 3,
    })
  })

  it('omits an untouched secret so saving another field cannot wipe the credential', () => {
    const controls = buildConfigControls(manifest, status)
    const values = { ...initialFormValues(controls), search_calls_per_turn: 5 }
    expect(buildConfigPatch(controls, values)).toEqual({
      search_depth: 'advanced',
      search_calls_per_turn: 5,
    })
  })

  it('sends a secret only when one was typed', () => {
    const controls = buildConfigControls(manifest, status)
    const values = { ...initialFormValues(controls), api_key: 'tvly-new' }
    expect(buildConfigPatch(controls, values)).toMatchObject({ api_key: 'tvly-new' })
  })

  it('treats a plugin with no stored configuration as empty, not as broken', () => {
    const blank = { configured: false, values: {}, secrets: { api_key: false } }
    const controls = buildConfigControls(manifest, blank)
    expect(controls[0]).toMatchObject({ configured: false })
    expect(initialFormValues(controls)).toEqual({
      api_key: '',
      search_depth: 'basic',
      search_calls_per_turn: 3,
    })
  })
})

describe('conditional and provider fields', () => {
  const blank = { configured: false, values: {}, secrets: {} }
  const deepseek = (id: number, baseUrl: string, hasKey = true) => ({
    id, user_id: 1, name: `p${id}`, has_key: hasKey, headers: [], enabled: true, models_dev_provider_id: null,
    models_dev_provider_source: null, default_interface_id: null, credential_version: 1, created_at: 0,
    interfaces: [{ id: id * 10, provider_id: id, protocol: 'chat-completions' as const, base_url: baseUrl, native_files: false, created_at: 0 }],
  })

  it('shows and sends only the fields the current values call for', () => {
    const controls = buildConfigControls(webSearch, blank)
    const values = initialFormValues(controls)
    expect(values).toMatchObject({ backend: 'deepseek', deepseek_provider_id: null })
    expect(visibleControls(controls, values).map(control => control.key)).toEqual([
      'backend', 'deepseek_provider_id', 'deepseek_api_key', 'search_calls_per_turn', 'extract_calls_per_turn',
    ])

    const withProvider = { ...values, deepseek_provider_id: 7, tavily_search_depth: 'advanced' }
    expect(visibleControls(controls, withProvider).map(control => control.key)).not.toContain('deepseek_api_key')
    expect(buildConfigPatch(controls, withProvider)).toEqual({
      backend: 'deepseek', deepseek_provider_id: 7, search_calls_per_turn: 3, extract_calls_per_turn: 2,
    })
  })

  it('offers keyed providers on the field host, then the none choice', () => {
    const filter = { host: 'api.deepseek.com', noneLabel: '自定义 Key' }
    const providers = [deepseek(1, 'https://api.deepseek.com/v1'), deepseek(2, 'https://relay.example/v1'), deepseek(3, 'https://api.deepseek.com', false)]
    expect(providerOptions(filter, providers, null)).toEqual([{ value: 1, label: 'p1' }, { value: null, label: '自定义 Key' }])
  })

  it('keeps a stored reference that no longer qualifies visible instead of showing it as none', () => {
    const filter = { host: 'api.deepseek.com', noneLabel: '自定义 Key' }
    expect(providerOptions(filter, [], 9)).toEqual([
      { value: 9, label: '已删除的供应商（不可用）' },
      { value: null, label: '自定义 Key' },
    ])
  })
})
