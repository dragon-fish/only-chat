import type { PluginManifest } from '@/shared/plugins'
import { CONTEXT_COMPACTION_PLUGIN_ID } from '@/shared/plugins'
import { CONTEXT_COMPACTION_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: CONTEXT_COMPACTION_PLUGIN_ID,
  name: '上下文压缩',
  description: '对话接近模型上下文上限时，把之前的内容总结成摘要再继续。也可以用 /compress 手动压缩。',
  tools: [],
  configSchema: CONTEXT_COMPACTION_CONFIG_SCHEMA,
  config: [
    {
      key: 'auto',
      label: '自动压缩',
      type: 'boolean',
      help: '上下文用到模型上限的 80%（上限不低于 300k 的模型为 90%）时自动压缩。关闭后只能用 /compress 手动压缩。',
    },
  ],
  slashCommands: [
    { name: 'compress', description: '压缩上下文', argsHint: '[重点说明]' },
  ],
} satisfies PluginManifest

export default manifest
