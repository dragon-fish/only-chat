import type { ProviderWriteInput } from '@/shared/api'
import type { ProviderWithInterfaces } from '@/shared/models'

export function providerSettingsDraft(provider: ProviderWithInterfaces): ProviderWriteInput {
  return {
    name: provider.name,
    api_key: '',
    enabled: provider.enabled,
    interfaces: provider.interfaces.map(({ id, protocol, base_url, native_files }) => protocol === 'vertex-compatible'
      ? { id, protocol, base_url, native_files: false as const }
      : { id, protocol, base_url, native_files }),
    default_protocol: provider.interfaces.find(endpoint => endpoint.id === provider.default_interface_id)?.protocol ?? 'chat-completions',
    models_dev_provider: provider.models_dev_provider_source === 'manual' && provider.models_dev_provider_id
      ? { source: 'manual', provider_id: provider.models_dev_provider_id }
      : { source: 'endpoint' },
    default_image_model_id: provider.default_image_model_id ?? null,
  }
}
