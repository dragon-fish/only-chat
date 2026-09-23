import { computed, reactive, shallowRef } from 'vue'
import { ModelWriteInputSchema, type ModelWriteInput } from '@/shared/api'
import { ModelMetadataOverrideSchema, type ModelMetadataOverride } from '@/shared/model-metadata'
import type { ModelWithMetadata, ProviderInterface } from '@/shared/models'

export type ModelDraft = Required<Pick<ModelWriteInput, 'model_id' | 'interface_id' | 'enabled' | 'metadata_override' | 'image_extra_body'>>

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export function createModelDraft(model: ModelWithMetadata): ModelDraft {
  return {
    model_id: model.model_id, interface_id: model.interface_id, enabled: model.enabled,
    metadata_override: clone(model.metadata_override), image_extra_body: clone(model.image_extra_body),
  }
}

/** A display row may contain pending writes; only a server acknowledgement can advance the baseline. */
export function createModelEditorSession(authoritative: ModelWithMetadata, initial: ModelWithMetadata = authoritative) {
  const target = Object.freeze({ id: authoritative.id, provider_id: authoritative.provider_id })
  const acknowledged = shallowRef(clone(authoritative))
  const form = reactive(createModelDraft(initial))
  const dirty = computed(() => JSON.stringify({ ...form, model_id: form.model_id.trim() }) !== JSON.stringify(createModelDraft(acknowledged.value)))
  return {
    target,
    form,
    get model() { return acknowledged.value },
    get dirty() { return dirty.value },
    patch(interfaces: readonly ProviderInterface[]) { return modelWriteFromDraft(acknowledged.value, form, interfaces) },
    acknowledge(model: ModelWithMetadata) {
      if (model.id !== target.id || model.provider_id !== target.provider_id) throw new Error('Cannot acknowledge a different model')
      acknowledged.value = clone(model)
    },
  }
}
export type ModelEditorSession = ReturnType<typeof createModelEditorSession>

export function metadataValue(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value)
}

export function setMetadataOverride(override: ModelMetadataOverride, path: string, value: unknown): ModelMetadataOverride {
  const result = clone(override) as Record<string, unknown>
  const keys = path.split('.')
  let target = result
  for (const key of keys.slice(0, -1)) {
    const current = target[key]
    if (current === null || typeof current !== 'object' || Array.isArray(current)) target[key] = {}
    target = target[key] as Record<string, unknown>
  }
  target[keys.at(-1)!] = value
  return ModelMetadataOverrideSchema.parse(result)
}

export function resetMetadataOverride(override: ModelMetadataOverride, path: string): ModelMetadataOverride {
  const result = clone(override) as Record<string, unknown>
  function remove(target: Record<string, unknown>, keys: string[]) {
    const key = keys[0]!
    if (keys.length === 1) { delete target[key]; return }
    const child = target[key]
    if (child === null || typeof child !== 'object' || Array.isArray(child)) return
    remove(child as Record<string, unknown>, keys.slice(1))
    if (Object.keys(child).length === 0) delete target[key]
  }
  remove(result, path.split('.'))
  return ModelMetadataOverrideSchema.parse(result)
}

export function modelWriteFromDraft(model: ModelWithMetadata, draft: ModelDraft, interfaces: readonly ProviderInterface[]): Partial<ModelWriteInput> {
  const parsed = ModelWriteInputSchema.parse({ ...draft, model_id: draft.model_id.trim() })
  if (parsed.interface_id !== null && !interfaces.some(endpoint => endpoint.id === parsed.interface_id && endpoint.provider_id === model.provider_id)) {
    throw new Error('Model interface must belong to its provider')
  }
  const write: Partial<ModelWriteInput> = {}
  if (parsed.model_id !== model.model_id) write.model_id = parsed.model_id
  if (parsed.interface_id !== model.interface_id) write.interface_id = parsed.interface_id
  if (parsed.enabled !== model.enabled) write.enabled = parsed.enabled
  if (JSON.stringify(parsed.metadata_override) !== JSON.stringify(model.metadata_override)) write.metadata_override = parsed.metadata_override
  if (JSON.stringify(parsed.image_extra_body) !== JSON.stringify(model.image_extra_body)) write.image_extra_body = parsed.image_extra_body
  return write
}

export function catalogSource(model: ModelWithMetadata): string {
  const matches = Object.values(model.catalog_matches).filter(match => match !== null)
  return matches.length ? `models.dev · ${matches.map(match => `${match.provider_id}/${match.model_id} (${match.kind})`).join('、')}` : '无目录匹配，使用默认值'
}
