import type { PluginManifest } from '@/shared/plugins'
import {
  COMFYUI_GENERATE_TOOL_ID, COMFYUI_LIST_MODELS_TOOL_ID, COMFYUI_LIST_WORKFLOWS_TOOL_ID, COMFYUI_NODE_INFO_TOOL_ID,
  COMFYUI_PLUGIN_ID, COMFYUI_READ_TOOL_ID,
} from '@/shared/plugins'
import { COMFYUI_CONFIG_SCHEMA } from './shared'

const manifest = {
  id: COMFYUI_PLUGIN_ID,
  name: 'ComfyUI',
  description: '让模型用你自己的 ComfyUI 出图：查模型与节点、套用模板或直接提交工作流，完成后图片自动回到对话。',
  tools: [
    { id: COMFYUI_LIST_WORKFLOWS_TOOL_ID, name: '列出模板', description: '查看可用的工作流模板与提示词指南。' },
    { id: COMFYUI_READ_TOOL_ID, name: '读取模板或指南', description: '读取一个模板的原始工作流，或一份提示词指南。' },
    { id: COMFYUI_LIST_MODELS_TOOL_ID, name: '列出模型', description: '查看 ComfyUI 上的模型目录与模型文件。' },
    { id: COMFYUI_NODE_INFO_TOOL_ID, name: '查询节点', description: '查看节点的输入、输出与可选值，或按关键词搜索节点。' },
    { id: COMFYUI_GENERATE_TOOL_ID, name: 'ComfyUI 出图', description: '按模板或完整工作流在后台出图，完成后通知模型。' },
  ],
  configSchema: COMFYUI_CONFIG_SCHEMA,
  config: [
    { key: 'base_url', label: '地址', type: 'text', placeholder: 'https://comfy.example.com', help: 'ComfyUI 的访问地址，必须是 https。' },
    { key: 'headers', label: '请求头', type: 'key_value', help: '随每个请求发送，用于认证。Cloudflare Zero Trust 填 CF-Access-Client-Id 与 CF-Access-Client-Secret；Basic Auth 填 Authorization。上锁的值加密保存，之后不再显示。' },
    { key: 'workflows_dir', label: '模板目录', type: 'text', placeholder: 'api-workflows', help: 'ComfyUI userdata 下存放模板的目录。里面必须是 Workflow → Export (API) 导出的 JSON。留空则不使用模板。' },
    { key: 'guides_dir', label: '指南目录', type: 'text', placeholder: 'guides', help: 'ComfyUI userdata 下存放提示词指南（Markdown）的目录。留空则不使用指南。' },
  ],
  configIntro: {
    why: '模型会查询你 ComfyUI 上的模型和节点，套用模板或自己拼工作流出图。',
    where: '模板和指南放在 ComfyUI 的 user/default/<目录>/ 下，可以手动放，也可以用自定义节点自动保存。经 Cloudflare Zero Trust 保护时，在 Access → Service Auth 创建 Service Token 并在应用策略里放行，再把它的两个请求头填进来。',
  },
} satisfies PluginManifest

export default manifest
