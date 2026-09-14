import type { PluginManifest } from '@/shared/plugins'
import {
  DELETE_FILE_TOOL_ID, LIST_FILES_TOOL_ID, PREVIEW_FILE_TOOL_ID, READ_FILE_TOOL_ID,
  RENAME_FILE_TOOL_ID, RESTORE_FILE_TOOL_ID, WORKSPACE_FILES_PLUGIN_ID, WRITE_FILE_TOOL_ID,
} from '@/shared/plugins'
import { WORKSPACE_FILES_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: WORKSPACE_FILES_PLUGIN_ID,
  name: '工作区文件',
  description: '让模型在 Project 与会话中读写持久化的文本文件。写入会保留历史版本。',
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
    {
      id: RESTORE_FILE_TOOL_ID,
      name: '还原文件',
      description: '把某个历史版本还原为一个新文件，不会覆盖任何现有文件。',
    },
    {
      id: RENAME_FILE_TOOL_ID,
      name: '重命名文件',
      description: '改名、移动，或整个目录一起搬，历史版本跟着走。',
    },
    {
      id: PREVIEW_FILE_TOOL_ID,
      name: '预览文件',
      description: '拿到一个能在浏览器里打开该文件的短时效链接。是否按网页渲染由下面的开关决定。',
    },
    {
      id: DELETE_FILE_TOOL_ID,
      name: '删除文件',
      description: '把文件或整个目录移入回收站，30 天内你都可以在这里还原。',
    },
  ],
  settingsEntry: { label: '工作区文件', description: '模型在 Project 与对话中读写的文本文件' },
  workspaceTab: { label: '文件' },
  configSchema: WORKSPACE_FILES_CONFIG_SCHEMA,
  config: [
    {
      key: 'html_preview',
      label: '在应用内渲染 HTML 与 SVG',
      type: 'boolean',
      help: '开启后，可以把模型写的 HTML 或 SVG 当作页面预览，同目录的 CSS 与 JS 会一起加载。页面运行在沙箱框架里，拿不到本站的登录状态，但它终究是模型生成的、可执行的代码，只在你确实需要看效果时开启。关闭时这些文件只会以纯文本呈现。',
    },
  ],
  configIntro: {
    why: '文件读写本身不需要任何配置，这里只有一个开关：是否允许在应用内渲染模型写出来的页面。',
    where: '关闭时预览只显示源码，Markdown 预览与打包下载始终可用。',
  },
} satisfies PluginManifest

export default manifest
