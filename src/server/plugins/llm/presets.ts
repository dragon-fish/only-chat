import type { ModelCapabilities, Protocol } from '@/shared/models'

export interface PresetModel { model_id: string; display_name: string; capabilities: ModelCapabilities }
export interface PresetProvider {
  key: string
  name: string
  protocol: Protocol
  base_url: string
  /** Only presets known to implement a Files API with upload-time expiry default this on. */
  native_files: boolean
  models: PresetModel[]
}

export const PRESET_PROVIDERS: PresetProvider[] = [
  {
    key: 'openai', name: 'OpenAI', protocol: 'openai-responses', base_url: 'https://api.openai.com/v1', native_files: true,
    models: [
      { model_id: 'gpt-5.1', display_name: 'GPT-5.1', capabilities: { vision: true, reasoning: true, tools: true } },
      { model_id: 'gpt-5-mini', display_name: 'GPT-5 mini', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
  {
    key: 'anthropic', name: 'Anthropic', protocol: 'anthropic', base_url: 'https://api.anthropic.com/v1', native_files: false,
    models: [
      { model_id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', capabilities: { vision: true, reasoning: true, tools: true } },
      { model_id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
  {
    key: 'deepseek', name: 'DeepSeek', protocol: 'openai-completions', base_url: 'https://api.deepseek.com/v1', native_files: false,
    models: [
      { model_id: 'deepseek-chat', display_name: 'DeepSeek Chat', capabilities: { tools: true } },
      { model_id: 'deepseek-reasoner', display_name: 'DeepSeek Reasoner', capabilities: { reasoning: true } },
    ],
  },
  {
    key: 'openrouter', name: 'OpenRouter', protocol: 'openai-completions', base_url: 'https://openrouter.ai/api/v1', native_files: false,
    models: [],
  },
  {
    key: 'vertex', name: 'Google Vertex AI', protocol: 'vertex', base_url: 'https://aiplatform.googleapis.com', native_files: false,
    models: [
      { model_id: 'gemini-3-pro-preview', display_name: 'Gemini 3 Pro', capabilities: { vision: true, reasoning: true, tools: true } },
    ],
  },
]
