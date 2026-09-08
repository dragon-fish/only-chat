import type { PluginManifest } from '@/shared/plugins'
import { ASK_USER_PLUGIN_ID, ASK_USER_TOOL_ID } from '@/shared/plugins'

const manifest = {
  id: ASK_USER_PLUGIN_ID,
  name: 'Ask User',
  description: 'Ask the user focused follow-up questions.',
  defaultTools: [ASK_USER_TOOL_ID],
} satisfies PluginManifest

export default manifest
