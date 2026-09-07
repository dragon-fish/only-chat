import type { ModelInput, ModelWriteInput } from '@/shared/api'
import { ReasoningEffortSchema, type Model, type ModelWithMetadata, type Provider, type ProviderWithInterfaces } from '@/shared/models'

/** Internal projection for the editor/picker awaiting the metadata UI cutover. Never use as a wire DTO. */
export function legacyProviderView(provider: ProviderWithInterfaces): Provider {
  const endpoint = provider.interfaces.find(item => item.id === provider.default_interface_id)
  return {
    id: provider.id, user_id: provider.user_id, name: provider.name, enabled: provider.enabled, has_key: provider.has_key,
    created_at: provider.created_at, extra: null, base_url: endpoint?.base_url ?? '', native_files: endpoint?.native_files ?? false,
    protocol: endpoint?.protocol === 'responses' ? 'openai-responses' : endpoint?.protocol === 'chat-completions' ? 'openai-completions' : endpoint?.protocol ?? 'openai-completions',
  }
}

export function legacyModelView(model: ModelWithMetadata): Model {
  const metadata = model.metadata
  const effort = metadata.reasoning_options?.find(option => option.type === 'effort')
  const efforts = effort?.type === 'effort' && effort.values ? effort.values.flatMap(value => {
    const parsed = ReasoningEffortSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  }) : []
  return {
    id: model.id, provider_id: model.provider_id, model_id: model.model_id, display_name: metadata.name ?? model.model_id,
    enabled: model.enabled, sort: model.sort,
    capabilities: {
      ...(metadata.modalities ? { vision: metadata.modalities.input.includes('image'), image_output: metadata.modalities.output.includes('image') } : {}),
      ...(metadata.reasoning !== undefined ? { reasoning: metadata.reasoning } : {}),
      ...(metadata.tool_call !== undefined ? { tools: metadata.tool_call } : {}),
      ...(metadata.reasoning_options ? { reasoning_can_disable: metadata.reasoning_options.some(option => option.type === 'toggle') } : {}),
      ...(efforts.length ? { reasoning_efforts: efforts } : {}),
    },
    pricing: metadata.cost ? { input: metadata.cost.input, output: metadata.cost.output, cached: metadata.cost.cache_read } : null,
  }
}

/** Translate only changed legacy controls into overrides, preserving catalog inheritance and other metadata. */
export function legacyModelWrite(model: ModelWithMetadata, patch: Partial<ModelInput>): Partial<ModelWriteInput> {
  const baseline = legacyModelView(model)
  const override: ModelWithMetadata['metadata_override'] = JSON.parse(JSON.stringify(model.metadata_override))
  const write: Partial<ModelWriteInput> = {}
  if (patch.model_id !== undefined) write.model_id = patch.model_id
  if (patch.enabled !== undefined) write.enabled = patch.enabled
  if (patch.sort !== undefined) write.sort = patch.sort
  if (patch.display_name !== undefined && patch.display_name !== baseline.display_name) override.name = patch.display_name
  if (patch.capabilities) {
    const flags = patch.capabilities
    if (flags.reasoning !== baseline.capabilities.reasoning && flags.reasoning !== undefined) override.reasoning = flags.reasoning
    if (flags.tools !== baseline.capabilities.tools && flags.tools !== undefined) override.tool_call = flags.tools
    for (const [flag, direction] of [['vision', 'input'], ['image_output', 'output']] as const) {
      if (flags[flag] === undefined || flags[flag] === baseline.capabilities[flag]) continue
      const modalities = model.metadata.modalities?.[direction] ?? ['text']
      override.modalities = { ...override.modalities, [direction]: flags[flag] ? [...new Set([...modalities, 'image'])] : modalities.filter(item => item !== 'image') }
    }
    const effortChanged = JSON.stringify(flags.reasoning_efforts ?? []) !== JSON.stringify(baseline.capabilities.reasoning_efforts ?? [])
    const toggleChanged = flags.reasoning_can_disable !== undefined && flags.reasoning_can_disable !== baseline.capabilities.reasoning_can_disable
    if (effortChanged || toggleChanged) {
      let options = [...(model.metadata.reasoning_options ?? [])]
      if (effortChanged) options = options.filter(option => option.type !== 'effort')
      if (toggleChanged) options = options.filter(option => option.type !== 'toggle')
      if (effortChanged && flags.reasoning_efforts?.length) options.push({ type: 'effort', values: flags.reasoning_efforts })
      if (toggleChanged && flags.reasoning_can_disable) options.push({ type: 'toggle' })
      override.reasoning_options = options
    }
  }
  if (JSON.stringify(override) !== JSON.stringify(model.metadata_override)) write.metadata_override = override
  return write
}
