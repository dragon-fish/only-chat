import type { PluginManifest } from '@/shared/plugins'
import { FILE_READER_PLUGIN_ID, READ_FILE_TOOL_ID } from '@/shared/plugins'

const manifest = {
  id: FILE_READER_PLUGIN_ID,
  name: '读取文件',
  description: '让模型按需读取对话里的附件：文本分段读，图片、PDF 等交给模型直接看。其他文件类插件依赖它。',
  tools: [
    {
      id: READ_FILE_TOOL_ID,
      name: '读取文件',
      description: '按行读取文本，可指定起始行与行数；图片、PDF 等文件直接交给模型查看。',
    },
  ],
} satisfies PluginManifest

export default manifest
