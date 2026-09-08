import type { ModelWithMetadata, ProviderWithInterfaces } from '@/shared/models'

export const provider: ProviderWithInterfaces = {
  id: 1, user_id: 1, name: 'Example', enabled: true, has_key: false, created_at: 0,
  credential_version: 1, default_interface_id: 10, models_dev_provider_id: null, models_dev_provider_source: 'endpoint',
  interfaces: [{ id: 10, provider_id: 1, protocol: 'chat-completions', base_url: 'https://example.com/v1', native_files: false, created_at: 0 }],
}

export const modelRecords: ModelWithMetadata[] = [
  { id: 2, provider_id: 1, model_id: 'first-model', metadata: { name: 'First model', modalities: { input: ['text', 'image'], output: ['text'] } }, enabled: true, sort: 0,
    interface_id: null, metadata_override: {}, catalog_matches: { operator: null, lab: null, global: null }, lab_id: null },
  { id: 3, provider_id: 1, model_id: 'second-model', metadata: { name: 'Second model', reasoning: true }, enabled: false, sort: 1,
    interface_id: null, metadata_override: {}, catalog_matches: { operator: null, lab: null, global: null }, lab_id: null },
]

export const catalogStatus = { version: 'v1', previousVersion: null, lastSuccessAt: 1, lastError: null }
