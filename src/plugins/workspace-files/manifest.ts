import type { PluginManifest } from '@/shared/plugins'
import { LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID } from './shared'

const manifest = {
  id: 'workspace_files',
  name: '工作区文件',
  description: '让模型在 Project 与会话中读写持久化的文本文件。',
  defaultTools: [LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, WRITE_FILE_TOOL_ID],
} satisfies PluginManifest

export default manifest
