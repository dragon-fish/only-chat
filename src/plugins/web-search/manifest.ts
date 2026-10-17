import type { PluginManifest } from '@/shared/plugins'
import { WEB_EXTRACT_TOOL_ID, WEB_SEARCH_PLUGIN_ID, WEB_SEARCH_TOOL_ID } from '@/shared/plugins'
import { DEEPSEEK_API_HOST, WEB_SEARCH_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: WEB_SEARCH_PLUGIN_ID,
  name: '联网搜索',
  description: '让模型搜索网页并抓取正文。由 DeepSeek 或 Tavily 提供。',
  tools: [
    { id: WEB_SEARCH_TOOL_ID, name: '联网搜索', description: '按关键词搜索网页，返回标题、链接与摘要。' },
    { id: WEB_EXTRACT_TOOL_ID, name: '网页抓取', description: '抓取指定网页的正文，用于摘要不够时深入阅读。' },
  ],
  configSchema: WEB_SEARCH_CONFIG_SCHEMA,
  config: [
    {
      key: 'backend', label: '搜索服务', type: 'select',
      help: '同一时间只有一家生效。切换后另一家的配置仍然保留。',
      optionLabels: { deepseek: 'DeepSeek', tavily: 'Tavily' },
    },
    {
      key: 'deepseek_provider_id', label: 'DeepSeek 凭证', type: 'provider', when: { backend: 'deepseek' },
      help: '搜索与对话共用 DeepSeek 的 API Key。选择已保存的 DeepSeek 官方供应商，它更换 Key 时这里自动跟随。',
      provider: { host: DEEPSEEK_API_HOST, noneLabel: '自定义 Key' },
    },
    {
      key: 'deepseek_api_key', label: 'DeepSeek API Key', type: 'secret', when: { backend: 'deepseek', deepseek_provider_id: null },
      help: '在 DeepSeek 开放平台创建，请勿泄露给无关人员。',
    },
    {
      key: 'tavily_api_key', label: 'Tavily API Key', type: 'secret', when: { backend: 'tavily' },
      help: '在 Tavily 控制台（app.tavily.com）创建，请勿泄露给无关人员。',
    },
    {
      key: 'tavily_search_depth', label: '搜索深度', type: 'select', when: { backend: 'tavily' },
      help: 'advanced 结果更全但更慢、更贵。',
    },
    { key: 'search_calls_per_turn', label: '每轮搜索次数上限', type: 'number', help: '一次回答内最多搜索几次。搜不到时模型应该回来跟你对齐需求，而不是反复换词硬搜。' },
    { key: 'extract_calls_per_turn', label: '每轮抓取次数上限', type: 'number', help: '一次回答内最多抓取几次。每次可以一起传多个 URL。' },
  ],
  configIntro: {
    why: '模型用它查询时效信息、训练截止之后的事实，以及需要读原文才能回答的问题。',
    where: 'DeepSeek 按次计费，与对话共用账户余额；Tavily 有免费额度，个人使用通常够用。',
    link: { label: '前往 DeepSeek 开放平台 →', href: 'https://platform.deepseek.com/api_keys' },
  },
} satisfies PluginManifest

export default manifest
