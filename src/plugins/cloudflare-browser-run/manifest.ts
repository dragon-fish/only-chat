import type { PluginManifest } from '@/shared/plugins'
import { BROWSER_HANDOFF_TOOL_ID, BROWSER_RUN_PLUGIN_ID, BROWSER_USE_TOOL_ID } from '@/shared/plugins'
import { BROWSER_RUN_CONFIG_SCHEMA, BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA, HANDOFF_DONE_STATUSES } from './shared'

const manifest = {
  id: BROWSER_RUN_PLUGIN_ID,
  name: '浏览器',
  description: '给模型一个真实的浏览器：它写 Playwright 代码操作网页，你在旁边看着，随时接手。',
  requiresProject: true,
  workspaceTab: { label: '浏览器' },
  tools: [
    {
      id: BROWSER_USE_TOOL_ID,
      name: '操作浏览器',
      description: '在会话专属的浏览器里运行模型写的 Playwright 代码。',
    },
    {
      id: BROWSER_HANDOFF_TOOL_ID,
      name: '请求接管',
      description: '登录、验证码这类模型做不了的步骤，交给你在实时画面里完成。',
      human: { doneStatuses: HANDOFF_DONE_STATUSES },
    },
  ],
  configSchema: BROWSER_RUN_CONFIG_SCHEMA,
  config: [
    {
      key: 'keep_alive_ms',
      label: '浏览器空闲保活（毫秒）',
      type: 'number',
      help: '两次调用之间浏览器保持打开的时间，最长 10 分钟。开着就在计费，闲置时间越长越贵，但重开会丢掉未保存的页面状态。',
    },
    {
      key: 'default_timeout_ms',
      label: '单次代码默认时限（毫秒）',
      type: 'number',
      help: '模型没有指定时一次 browser_use 允许运行的时间，最长 5 分钟。',
    },
  ],
  configIntro: {
    why: '不需要任何密钥，浏览器由 Cloudflare Browser Run 提供并按使用时长计费。这里只决定它闲着多久关掉、一次代码最多跑多久。',
  },
  conversationConfigSchema: BROWSER_RUN_CONVERSATION_CONFIG_SCHEMA,
  conversationConfig: [
    {
      key: 'browser_profile',
      label: '浏览器登录态',
      type: 'select',
      help: 'ephemeral：用完即弃；project：这个 Project 里的会话共用一份 cookie 与登录；user：你的所有 Project 共用。',
    },
  ],
} satisfies PluginManifest

export default manifest
