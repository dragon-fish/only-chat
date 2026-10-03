import type { PluginManifest } from '@/shared/plugins'
import { MEMORY_PLUGIN_ID, MEMORY_SAVE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
import { MEMORY_CONFIG_SCHEMA, MEMORY_CONVERSATION_CONFIG_SCHEMA, MEMORY_PROJECT_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: MEMORY_PLUGIN_ID,
  name: '记忆',
  description: '让模型跨会话记住你的偏好与项目背景。记忆是工作区里的文件，你可以随时查看或删除。',
  requires: [WORKSPACE_FILES_PLUGIN_ID],
  tools: [{
    id: MEMORY_SAVE_TOOL_ID,
    name: '保存记忆',
    description: '新建一条记忆，或修改它在目录里的描述。读、改、删记忆用工作区文件工具。',
  }],
  settingsEntry: { label: '记忆', description: '查看和删除模型记住的关于你的事' },
  projectTab: { label: '记忆' },
  configSchema: MEMORY_CONFIG_SCHEMA,
  config: [
    {
      key: 'user_memory',
      label: '用户记忆',
      type: 'boolean',
      help: '关于你本人的记忆，在所有会话里可用。关闭后模型看不到也写不了它们，已有的记忆仍然保留，可以在记忆页查看。',
    },
  ],
  projectConfigSchema: MEMORY_PROJECT_CONFIG_SCHEMA,
  conversationConfigSchema: MEMORY_CONVERSATION_CONFIG_SCHEMA,
  conversationConfig: [
    {
      key: 'user_memory',
      label: '在本会话使用用户记忆',
      type: 'boolean',
      help: '还需要用户记忆总开关开启；在 Project 里时，还需要该 Project 允许使用用户记忆。',
    },
    {
      key: 'project_memory',
      label: '在本会话使用项目记忆',
      type: 'boolean',
      help: '只对 Project 里的会话有效，还需要该 Project 的项目记忆开启。',
    },
  ],
} satisfies PluginManifest

export default manifest
