import type { PluginManifest } from '@/shared/plugins'
import { ANALYZE_FILE_TOOL_ID, FILE_UNDERSTANDING_PLUGIN_ID, VIEW_FILE_TOOL_ID } from '@/shared/plugins'

const manifest = {
  id: FILE_UNDERSTANDING_PLUGIN_ID,
  name: '文件理解',
  description: '让模型查看对话里的图片、PDF、音频和视频，或交给文件理解模型详细描述。',
  tools: [
    {
      id: VIEW_FILE_TOOL_ID,
      name: '查看文件',
      description: '把对话里的文件直接交给当前模型查看。',
    },
    {
      id: ANALYZE_FILE_TOOL_ID,
      name: '分析文件',
      description: '委托文件理解模型详细描述图片、PDF、音频或视频，可附带问题。',
    },
  ],
} satisfies PluginManifest

export default manifest
