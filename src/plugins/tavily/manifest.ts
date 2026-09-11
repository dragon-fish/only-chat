import type { PluginManifest } from '@/shared/plugins'
import { TAVILY_PLUGIN_ID, WEB_EXTRACT_TOOL_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import { TAVILY_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: TAVILY_PLUGIN_ID,
  name: 'Tavily 联网搜索',
  description: '让模型搜索网页并抓取正文。需要 Tavily API Key。',
  tools: [
    { id: WEB_SEARCH_TOOL_ID, name: '联网搜索', description: '按关键词搜索网页，返回标题、链接与摘要。' },
    { id: WEB_EXTRACT_TOOL_ID, name: '网页抓取', description: '抓取指定网页的正文，用于摘要不够时深入阅读。' },
  ],
  configSchema: TAVILY_CONFIG_SCHEMA,
  config: [
    { key: 'api_key', label: 'API Key', type: 'secret', help: '在 Tavily 控制台创建，请勿泄露给无关人员。' },
    { key: 'search_depth', label: '搜索深度', type: 'select', help: 'advanced 结果更全但更慢、更贵。' },
    { key: 'search_calls_per_turn', label: '每轮搜索次数上限', type: 'number', help: '一次回答内最多搜索几次。搜不到时模型应该回来跟你对齐需求，而不是反复换词硬搜。' },
    { key: 'extract_calls_per_turn', label: '每轮抓取次数上限', type: 'number', help: '一次回答内最多抓取几次。每次可以一起传多个 URL。' },
  ],
  configIntro: {
    why: '模型用它查询时效信息、训练截止之后的事实，以及需要读原文才能回答的问题。',
    where: '在 Tavily 注册后于控制台创建 API Key。免费额度对个人使用通常够用。',
    link: { label: '前往 Tavily 控制台 →', href: 'https://app.tavily.com/home' },
  },
} satisfies PluginManifest

export default manifest
