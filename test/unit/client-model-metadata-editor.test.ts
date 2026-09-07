import { describe, expect, it } from 'vitest'
import { createModelDraft, createModelEditorSession, modelWriteFromDraft, resetMetadataOverride, setMetadataOverride } from '@/client/lib/model-editor'
import { modelRecords, provider } from './provider-fixtures'

describe('metadata override editor', () => {
  it('compares dirty state with the same normalized model ID sent in a write', () => {
    const session = createModelEditorSession(modelRecords[0]!)
    session.form.model_id = ' first-model '
    expect(session.patch(provider.interfaces)).toEqual({})
    expect(session.dirty).toBe(false)
  })

  it('keeps optimistic input separate from the acknowledged baseline until a successful write', () => {
    const persisted = modelRecords[0]!
    const pending = { ...persisted, metadata_override: { name: 'Pending name' } }
    const session = createModelEditorSession(persisted, pending)
    expect(session.dirty).toBe(true)
    expect(session.patch(provider.interfaces)).toEqual({ metadata_override: { name: 'Pending name' } })
    expect(session.model.metadata_override).toEqual({})
    pending.metadata_override.name = 'Another row edit'
    expect(session.form.metadata_override.name).toBe('Pending name')
    session.acknowledge({ ...persisted, metadata_override: { name: 'Pending name' } })
    expect(session.dirty).toBe(false)
    expect(session.patch(provider.interfaces)).toEqual({})
  })

  it('advances only the acknowledged layer and keeps newer edits and the stable row target', () => {
    const session = createModelEditorSession(modelRecords[0]!)
    session.form.model_id = 'renamed-model'
    session.form.metadata_override = { name: 'Newer draft' }
    session.acknowledge({ ...modelRecords[0]!, model_id: 'renamed-model', metadata_override: { name: 'First submission' } })
    expect(session.target).toEqual({ id: 2, provider_id: 1 })
    expect(session.dirty).toBe(true)
    expect(session.patch(provider.interfaces)).toEqual({ metadata_override: { name: 'Newer draft' } })
    expect(() => session.acknowledge(modelRecords[1]!)).toThrow(/different model/i)
    expect(session.model.metadata_override.name).toBe('First submission')
  })

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
