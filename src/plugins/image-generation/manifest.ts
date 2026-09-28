import type { PluginManifest } from '@/shared/plugins'
import { FILE_READER_PLUGIN_ID, GENERATE_IMAGE_TOOL_ID, IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'

const manifest = {
  id: IMAGE_GENERATION_PLUGIN_ID,
  name: '生成图片',
  description: '让模型在后台生成或编辑图片，完成后自动回到对话。使用会话或全局设置的生图模型。',
  // Edits name their references, and results come back, as asset: references.
  requires: [FILE_READER_PLUGIN_ID],
  tools: [{
    id: GENERATE_IMAGE_TOOL_ID,
    name: '生成图片',
    description: '在后台生成或编辑图片，完成后通知模型。',
  }],
} satisfies PluginManifest

export default manifest
