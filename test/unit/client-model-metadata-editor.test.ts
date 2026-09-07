import { describe, expect, it } from 'vitest'
import { createModelDraft, modelWriteFromDraft, resetMetadataOverride, setMetadataOverride } from '@/client/lib/model-editor'
import { modelRecords, provider } from './provider-fixtures'

describe('metadata override editor', () => {
  it('writes only edited user intent without pinning any effective catalog fields', () => {
    const record = { ...modelRecords[0]!, metadata_override: { description: 'Existing override' } }
    const draft = createModelDraft(record)
    expect(modelWriteFromDraft(record, draft, provider.interfaces)).toEqual({})
    draft.metadata_override = setMetadataOverride(draft.metadata_override, 'name', 'My model')
    expect(modelWriteFromDraft(record, draft, provider.interfaces)).toEqual({ metadata_override: { description: 'Existing override', name: 'My model' } })
    expect(record.metadata_override).toEqual({ description: 'Existing override' })
  })

  it('preserves explicit false, zero, and null while resetting a nested field or group to fallback', () => {
    const record = { ...modelRecords[0]!, metadata_override: { cost: { input: 3, output: 4 }, limit: { context: 8000 } } }
    const draft = createModelDraft(record)
    draft.metadata_override = setMetadataOverride(draft.metadata_override, 'reasoning', false)
    draft.metadata_override = setMetadataOverride(draft.metadata_override, 'limit.context', 0)
    draft.metadata_override = resetMetadataOverride(draft.metadata_override, 'cost.input')
    expect(draft.metadata_override).toEqual({ cost: { output: 4 }, limit: { context: 0 }, reasoning: false })
    draft.metadata_override = resetMetadataOverride(draft.metadata_override, 'cost')
    draft.metadata_override = setMetadataOverride(draft.metadata_override, 'cost', null)
    expect(modelWriteFromDraft(record, draft, provider.interfaces).metadata_override).toEqual({ cost: null, limit: { context: 0 }, reasoning: false })
    draft.metadata_override = resetMetadataOverride(draft.metadata_override, 'limit.context')
    expect(draft.metadata_override).toEqual({ cost: null, reasoning: false })
  })

  it('rejects another provider interface and permits resetting to provider default', () => {
    const draft = createModelDraft(modelRecords[0]!)
    const foreign = { ...provider.interfaces[0]!, id: 99, provider_id: 2 }
    draft.interface_id = foreign.id
    expect(() => modelWriteFromDraft(modelRecords[0]!, draft, [...provider.interfaces, foreign])).toThrow(/interface/i)
    draft.interface_id = 10
    expect(modelWriteFromDraft(modelRecords[0]!, draft, provider.interfaces)).toEqual({ interface_id: 10 })
    draft.interface_id = null
    expect(modelWriteFromDraft({ ...modelRecords[0]!, interface_id: 10 }, draft, provider.interfaces)).toEqual({ interface_id: null })
  })
})
