import type { PluginManifest } from '@/shared/plugins'
import { MCP_CALL_TOOL_TOOL_ID, MCP_LIST_SERVICES_TOOL_ID, MCP_LIST_TOOLS_TOOL_ID, MCP_PLUGIN_ID } from '@/shared/plugins'

const manifest = {
  id: MCP_PLUGIN_ID,
  name: 'MCP 服务',
  description: '让模型调用你在设置里添加的远程 MCP 服务。服务和工具在用到时才查找，接入再多也不占用每轮的提示。',
  tools: [
    { id: MCP_LIST_SERVICES_TOOL_ID, name: '列出 MCP 服务', description: '查看已启用的服务，以及每个服务有哪些工具。' },
    { id: MCP_LIST_TOOLS_TOOL_ID, name: '查看 MCP 工具', description: '查看某个服务的工具说明与参数，可按关键词筛选。' },
    { id: MCP_CALL_TOOL_TOOL_ID, name: '调用 MCP 工具', description: '调用某个服务的一个工具。' },
  ],
  settingsEntry: { label: 'MCP', description: '添加远程 MCP 服务，配置请求头与授权' },
} satisfies PluginManifest

export default manifest
