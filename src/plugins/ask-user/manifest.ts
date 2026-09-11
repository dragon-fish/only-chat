import type { PluginManifest } from '@/shared/plugins'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'

const manifest = {
  id: ASK_USER_PLUGIN_ID,
  name: '询问用户',
  description: '让模型在继续前向你提出一至三个问题。',
  tools: [{
    id: ASK_USER_TOOL_ID,
    name: '询问用户',
    description: '让模型在继续前向你提出一至三个问题。',
  }],
} satisfies PluginManifest

export default manifest
