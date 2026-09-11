import type { PluginManifest } from '@/shared/plugins'
import { CURRENT_TIME_TOOL_ID, DATETIME_PLUGIN_ID } from '@/shared/plugins'

const manifest = {
  id: DATETIME_PLUGIN_ID,
  name: '当前时间',
  description: '让模型查询此刻的日期与时间，可指定时区。无需配置。',
  tools: [{
    id: CURRENT_TIME_TOOL_ID,
    name: '当前时间',
    description: '查询此刻的日期与时间，可指定 IANA 时区。',
  }],
} satisfies PluginManifest

export default manifest
