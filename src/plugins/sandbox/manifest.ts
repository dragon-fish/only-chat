import type { PluginManifest } from '@/shared/plugins'
import { FILE_READER_PLUGIN_ID, WORKSPACE_FILES_PLUGIN_ID } from '@/shared/plugins'
import { SANDBOX_CONFIG_SCHEMA, SANDBOX_EXEC_TOOL_ID, SANDBOX_EXPORT_TOOL_ID, SANDBOX_IMPORT_TOOL_ID, SANDBOX_PLUGIN_ID, SANDBOX_WRITE_FILE_TOOL_ID, SANDBOX_EDIT_FILE_TOOL_ID } from './shared'

const manifest = {
  id: SANDBOX_PLUGIN_ID,
  name: 'Sandbox',
  description: '给模型一台能执行代码的 Linux 机器：装依赖、跑脚本、处理文件，成果导出到工作区。',
  requires: [FILE_READER_PLUGIN_ID, WORKSPACE_FILES_PLUGIN_ID],
  adminOnly: true,
  tools: [
    {
      id: SANDBOX_EXEC_TOOL_ID,
      name: '执行命令',
      description: '在你的 Sandbox 里运行 shell 命令，可在后台运行长任务。',
    },
    {
      id: SANDBOX_WRITE_FILE_TOOL_ID,
      name: '写入文件',
      description: '在 Sandbox 里创建文件，或整个覆盖一个已有文件。',
    },
    {
      id: SANDBOX_EDIT_FILE_TOOL_ID,
      name: '编辑文件',
      description: '按文本替换的方式修改 Sandbox 里的文件。',
    },
    {
      id: SANDBOX_IMPORT_TOOL_ID,
      name: '导入到 Sandbox',
      description: '把工作区文件或对话附件放进 Sandbox。',
    },
    {
      id: SANDBOX_EXPORT_TOOL_ID,
      name: '导出到工作区',
      description: '把 Sandbox 里的文件发布到工作区，你就能看到和下载。',
    },
  ],
  configSchema: SANDBOX_CONFIG_SCHEMA,
  config: [
    {
      key: 'instance_type',
      label: '机器规格',
      type: 'select',
      help: 'standard-1 为 1/2 vCPU、4 GiB 内存、8 GB 磁盘，往上依次翻倍左右。下次开机时生效。',
    },
    {
      key: 'idle_minutes',
      label: '空闲关机（分钟）',
      type: 'number',
      help: '没有命令在跑超过这么久，就备份工作目录并关机。开着就按内存和磁盘计费。',
    },
    {
      key: 'default_timeout_ms',
      label: '单条命令默认时限（毫秒）',
      type: 'number',
      help: '模型没有指定时，一条前台命令允许运行的时间，最长 10 分钟。更长的任务让模型放到后台。',
    },
  ],
  configIntro: {
    why: '机器由 Cloudflare Containers 提供，需要 Workers Paid，按运行时长计费。工作目录在关机前备份到 R2，下次用到时恢复。',
  },
} satisfies PluginManifest

export default manifest
