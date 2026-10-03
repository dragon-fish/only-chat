import type { PluginManifest } from '@/shared/plugins'
import { MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'

const manifest = {
  id: MEMORY_PLUGIN_ID,
  name: '记忆',
  description: '让模型跨会话记住你的偏好与项目背景。记忆是工作区里的文件，你可以随时查看、修改或删除。',
  requires: [WORKSPACE_FILES_PLUGIN_ID],
  tools: [{
    id: MEMORY_SAVE_TOOL_ID,
    name: '保存记忆',
    description: '新建一条记忆，或修改它在目录里的描述。读、改、删记忆用工作区文件工具。',
  }],
} satisfies PluginManifest

export default manifest
