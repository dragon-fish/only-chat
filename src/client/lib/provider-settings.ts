import type { CodexProviderUpdate, ProviderWriteInput } from '@/shared/api'
import type { OAuthCredentialStatus, ProviderWithInterfaces } from '@/shared/models'

export type ProviderSettingsDraft =
  | { kind: 'custom'; input: ProviderWriteInput }
  | { kind: 'codex-oauth'; input: CodexProviderUpdate }

export function codexOAuthStatusLabel(status: OAuthCredentialStatus): string {
  return {
    connected: '已连接',
    'reconnect-required': '需要重新连接',
    disconnected: '已断开',
  }[status]
}

export function providerSettingsDraft(provider: ProviderWithInterfaces): ProviderSettingsDraft {
  if (provider.kind === 'codex-oauth') {
    return { kind: 'codex-oauth', input: { name: provider.name, enabled: provider.enabled } }
  }
  return {
    kind: 'custom',
    input: {
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
    },
  }
}
