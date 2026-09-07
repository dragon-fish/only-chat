// @vitest-environment happy-dom
import { createApp, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LabAvatar from '@/client/components/lab-avatar.vue'
import { groupModelEntries, modelName, modelBadges } from '@/client/lib/ui-models'
import { modelRecords, provider } from './provider-fixtures'

let cleanup = () => {}
afterEach(() => { cleanup(); document.body.innerHTML = '' })

describe('model Lab presentation', () => {
  it('falls back to the provider avatar after a remote logo error without retrying on rerender', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp(LabAvatar, { labId: 'deepseek', providerName: 'Example Gateway' })
    app.mount(host)
    cleanup = () => app.unmount()
    const image = host.querySelector('img')!
    expect(image.getAttribute('src')).toBe('https://models.dev/logos/labs/deepseek.svg')
    image.dispatchEvent(new Event('error'))
    await vi.waitFor(() => expect(host.textContent).toContain('EG'))
    await nextTick()
    expect(host.querySelector('img')).toBeNull()
  })
  it('groups Labs within each provider and omits a redundant single-Lab heading', () => {
    const other = { ...provider, id: 2, name: 'Official' }
    const groups = groupModelEntries([
      { provider, model: { ...modelRecords[0]!, lab_id: 'deepseek' } },
      { provider, model: { ...modelRecords[1]!, lab_id: null } },
      { provider: other, model: { ...modelRecords[0]!, provider_id: 2, lab_id: 'deepseek' } },
    ], [{ id: 'deepseek', name: 'DeepSeek' }])
    expect(groups.map(group => ({ provider: group.provider.name, headings: group.labs.map(lab => lab.heading), ids: group.labs.map(lab => lab.id) }))).toEqual([
      { provider: 'Example', headings: ['DeepSeek', '其他'], ids: ['deepseek', null] },
      { provider: 'Official', headings: [null], ids: ['deepseek'] },
    ])
  })

  it('uses a resolved exact Lab prefix only for grouping and keeps unmatched model facts absent', () => {
    const unknown = { ...modelRecords[0]!, model_id: 'deepseek/unlisted-vision', metadata: {}, lab_id: 'deepseek' }
    const caseMismatch = { ...unknown, id: 10, model_id: 'DeepSeek/unlisted-vision', lab_id: null }
    const groups = groupModelEntries([{ provider, model: unknown }, { provider, model: caseMismatch }])
    expect(groups[0]!.labs.map(lab => lab.heading)).toEqual(['Deepseek', '其他'])
    expect(modelName(unknown)).toBe('deepseek/unlisted-vision')
    expect(modelBadges(unknown)).toEqual([])
    expect(unknown.metadata).toEqual({})
  })

  it('derives labels exclusively from effective metadata and preserves false values', () => {
    const model = { ...modelRecords[0]!, metadata: { name: 'Human name', reasoning: false, tool_call: true, modalities: { input: ['text' as const], output: ['image' as const] } } }
    expect(modelName(model)).toBe('Human name')
    expect(modelBadges(model).map(badge => badge.key)).toEqual(['tools', 'image_output'])
  })
})
