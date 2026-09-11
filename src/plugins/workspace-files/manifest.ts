import type { PluginManifest } from '@/shared/plugins'
import {
  LIST_FILES_TOOL_ID, READ_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID,
} from '@/shared/plugins'

const manifest = {
  id: WORKSPACE_FILES_PLUGIN_ID,
  name: '工作区文件',
  description: '让模型在 Project 与会话中读写持久化的文本文件。写入会保留历史版本。无需配置。',
  tools: [
    {
      id: LIST_FILES_TOOL_ID,
      name: '列出文件',
      description: '查看工作区里有哪些文件，不读取内容。',
    },
    {
      id: READ_FILE_TOOL_ID,
      name: '读取文件',
      description: '按行读取文本文件，可指定起始行与行数。',
    },
    {
      id: WRITE_FILE_TOOL_ID,
      name: '写入文件',
      description: '创建或整体替换一个文本文件，每次写入都会保留为一个版本。',
    },
  ],
} satisfies PluginManifest

export default manifest
