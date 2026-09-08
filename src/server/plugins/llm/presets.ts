import type { ProviderWriteInput } from '@/shared/api'

/** Identity shortcuts only. Catalog records supply metadata; membership is always explicit. */
export interface PresetProvider {
  key: string
  name: string
  interfaces: ProviderWriteInput['interfaces']
  default_protocol: ProviderWriteInput['default_protocol']
}

export const PRESET_PROVIDERS: PresetProvider[] = [
  { key: 'openai', name: 'OpenAI', default_protocol: 'responses', interfaces: [{ protocol: 'responses', base_url: 'https://api.openai.com/v1', native_files: true }] },
  { key: 'anthropic', name: 'Anthropic', default_protocol: 'anthropic', interfaces: [{ protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', native_files: false }] },
  { key: 'deepseek', name: 'DeepSeek', default_protocol: 'chat-completions', interfaces: [{ protocol: 'chat-completions', base_url: 'https://api.deepseek.com/v1', native_files: false }] },
  { key: 'openrouter', name: 'OpenRouter', default_protocol: 'chat-completions', interfaces: [{ protocol: 'chat-completions', base_url: 'https://openrouter.ai/api/v1', native_files: false }] },
]
