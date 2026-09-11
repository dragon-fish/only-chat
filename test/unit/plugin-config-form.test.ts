import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { buildConfigControls, buildConfigPatch, initialFormValues } from '@/client/lib/plugin-config-form'
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
