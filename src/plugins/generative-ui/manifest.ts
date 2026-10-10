import type { PluginManifest } from '@/shared/plugins'
import { GENERATIVE_UI_PLUGIN_ID, RENDER_UI_TOOL_ID } from './shared'

const manifest = {
  id: GENERATIVE_UI_PLUGIN_ID,
  name: '交互卡片',
  description: '让模型在对话里画出图表、表格、表单、计算器等可交互卡片（OpenUI）。',
  tools: [{
    id: RENDER_UI_TOOL_ID,
    name: '交互卡片',
    description: '用 OpenUI Lang 绘制可交互的卡片。',
  }],
} satisfies PluginManifest

export default manifest
