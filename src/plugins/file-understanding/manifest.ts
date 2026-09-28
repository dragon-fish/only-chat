import type { PluginManifest } from '@/shared/plugins'
import { ANALYZE_FILE_TOOL_ID, FILE_READER_PLUGIN_ID, FILE_UNDERSTANDING_PLUGIN_ID } from '@/shared/plugins'

const manifest = {
  id: FILE_UNDERSTANDING_PLUGIN_ID,
  name: '文件理解',
  description: '把图片、PDF、音频和视频交给文件理解模型详细描述，当前模型看不了的文件也能理解。',
  requires: [FILE_READER_PLUGIN_ID],
  tools: [
    {
      id: ANALYZE_FILE_TOOL_ID,
      name: '分析文件',
      description: '委托文件理解模型详细描述图片、PDF、音频或视频，可附带问题。',
    },
  ],
} satisfies PluginManifest

export default manifest
