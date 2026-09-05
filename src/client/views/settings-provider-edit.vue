<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Switch } from '@/client/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import { ProtocolSchema, type Model, type Protocol } from '@/shared/models'

const props = defineProps<{ providerId: number | null }>()
const router = useRouter()
const config = useConfigStore()

const form = reactive({ name: '', protocol: 'openai-completions' as Protocol, base_url: '', api_key: '', enabled: true, project: '', location: '' })
const models = ref<Model[]>([])
const newModelId = ref('')
const status = ref('')

onMounted(async () => {
  if (!config.loaded) await config.load()
  const pid = props.providerId
  const p = pid === null ? undefined : config.providers.find((x) => x.id === pid)
  if (pid === null || !p) { await router.push('/settings/providers'); return }
  Object.assign(form, { name: p.name, protocol: p.protocol, base_url: p.base_url, enabled: p.enabled, project: String(p.extra?.project ?? ''), location: String(p.extra?.location ?? '') })
  models.value = await api.models(pid)
})

/** Every mutation below needs a concrete id; the guard above already redirected when there is none. */
function requireId(): number {
  if (props.providerId === null) throw new Error('missing provider id')
  return props.providerId
}

function report(err: unknown) {
  status.value = err instanceof Error ? err.message : String(err)
}

// reka-ui emits `AcceptableValue`; narrow here rather than in the template.
function onProtocolChange(value: unknown) {
  const parsed = ProtocolSchema.safeParse(value)
  if (parsed.success) form.protocol = parsed.data
}

async function save() {
  try {
    // The server clears `extra` whenever `protocol` arrives without it, so always send both.
    const extra = form.protocol === 'vertex' ? { project: form.project, location: form.location } : null
    await api.updateProvider(requireId(), { name: form.name, protocol: form.protocol, base_url: form.base_url, enabled: form.enabled, extra, ...(form.api_key ? { api_key: form.api_key } : {}) })
    form.api_key = ''
    status.value = '已保存'
    await config.load()
  } catch (err) { report(err) }
}
async function remove() {
  try {
    await api.deleteProvider(requireId())
    await config.load()
    await router.push('/settings/providers')
  } catch (err) { report(err) }
}
async function fetchModels() {
  status.value = '拉取中…'
  try {
    const r = await api.fetchModels(requireId())
    status.value = `导入 ${r.imported} 个新模型`
    models.value = await api.models(requireId())
  } catch (err) { report(err) }
}
async function addModel() {
  const model_id = newModelId.value.trim()
  if (!model_id) return
  status.value = ''
  try {
    await api.createModel(requireId(), { model_id })
    newModelId.value = ''
    models.value = await api.models(requireId())
    await config.load()
  } catch (err) { report(err) }
}
async function toggleModel(m: Model, key: 'enabled' | 'vision' | 'reasoning' | 'tools', value: boolean) {
  try {
    const patch = key === 'enabled' ? { enabled: value } : { capabilities: { ...m.capabilities, [key]: value } }
    await api.updateModel(requireId(), m.id, patch)
    models.value = await api.models(requireId())
    await config.load()
  } catch (err) { report(err) }
}
async function removeModel(m: Model) {
  try {
    await api.deleteModel(requireId(), m.id)
    models.value = await api.models(requireId())
    await config.load()
  } catch (err) { report(err) }
}
</script>

<template lang="pug">
.mx-auto.max-w-2xl.p-4.flex.flex-col.gap-4
  RouterLink.text-xs.text-muted-foreground(to="/settings/providers") ← 返回供应商列表
  h1.text-lg.font-semibold 编辑供应商
  .grid.gap-3
    div
      Label 名称
      Input(v-model="form.name")
    div
      Label 协议
      Select(:model-value="form.protocol" @update:model-value="onProtocolChange")
        SelectTrigger
          SelectValue
        SelectContent
          SelectItem(value="openai-completions") OpenAI Chat Completions（含各类兼容中转）
          SelectItem(value="openai-responses") OpenAI Responses
          SelectItem(value="anthropic") Anthropic Messages
          SelectItem(value="vertex") Google Vertex AI
    div
      Label Base URL
      Input(v-model="form.base_url" placeholder="https://api.example.com/v1")
    div
      Label {{ form.protocol === 'vertex' ? '服务账号 JSON（留空保持不变）' : 'API Key（留空保持不变）' }}
      Input(v-model="form.api_key" type="password" autocomplete="off")
    template(v-if="form.protocol === 'vertex'")
      div
        Label Project
        Input(v-model="form.project")
      div
        Label Location
        Input(v-model="form.location" placeholder="us-central1 / global")
    .flex.items-center.gap-2
      Switch(:model-value="form.enabled" @update:model-value="form.enabled = $event")
      Label 启用
  .flex.gap-2
    Button(@click="save") 保存
    Button(variant="secondary" :disabled="form.protocol === 'vertex'" @click="fetchModels") 从 /models 拉取
    Button(variant="destructive" class="ml-auto" @click="remove") 删除供应商
  p.text-xs.text-muted-foreground(v-if="status") {{ status }}
  h2.font-medium 模型
  .flex.gap-2
    Input(v-model="newModelId" placeholder="model id，例如 gpt-5.1" @keydown.enter="addModel")
    Button(@click="addModel") 添加
  table.w-full.text-sm
    thead
      tr.text-left.text-xs.text-muted-foreground
        th.py-1 模型
        th 启用
        th 视觉
        th 推理
        th 工具
        th
    tbody
      tr.border-t(v-for="m in models" :key="m.id")
        td.py-1
          span {{ m.display_name }}
          span.ml-1.text-xs.text-muted-foreground(v-if="m.display_name !== m.model_id") {{ m.model_id }}
        td
          Switch(:model-value="m.enabled" @update:model-value="toggleModel(m, 'enabled', $event)")
        td
          Switch(:model-value="!!m.capabilities.vision" @update:model-value="toggleModel(m, 'vision', $event)")
        td
          Switch(:model-value="!!m.capabilities.reasoning" @update:model-value="toggleModel(m, 'reasoning', $event)")
        td
          Switch(:model-value="!!m.capabilities.tools" @update:model-value="toggleModel(m, 'tools', $event)")
        td.text-right
          button.text-xs.text-destructive(@click="removeModel(m)") 删除
</template>
