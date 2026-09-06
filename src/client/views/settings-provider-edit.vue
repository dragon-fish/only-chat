<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Switch } from '@/client/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import { REASONING_LABELS } from '@/client/stores/sync'
import { ProtocolSchema, ReasoningEffortSchema, type Model, type ModelCapabilities, type Protocol, type ReasoningEffort } from '@/shared/models'
import type { ModelInput } from '@/shared/api'

/** The capability flags stored as plain booleans, next to the row's own `enabled` switch. */
type BooleanCapability = 'vision' | 'reasoning' | 'tools' | 'reasoning_can_disable' | 'image_output'

/** Weakest to strongest, straight from the schema, so the chips read in the slider's order. */
const REASONING_EFFORTS = ReasoningEffortSchema.options

const props = defineProps<{ providerId: number | null }>()
const router = useRouter()
const config = useConfigStore()

const form = reactive({ name: '', protocol: 'openai-completions' as Protocol, base_url: '', api_key: '', enabled: true, native_files: false, project: '', location: '' })
const models = ref<Model[]>([])
const newModelId = ref('')
const status = ref('')

/** Both Vertex shapes address models by resource path and expose no `/models` catalogue. */
const canFetchModels = computed(() => form.protocol !== 'vertex' && form.protocol !== 'vertex-compatible')

onMounted(async () => {
  if (!config.loaded) await config.load()
  const pid = props.providerId
  const p = pid === null ? undefined : config.providers.find((x) => x.id === pid)
  if (pid === null || !p) { await router.push('/settings/providers'); return }
  Object.assign(form, { name: p.name, protocol: p.protocol, base_url: p.base_url, enabled: p.enabled, native_files: p.native_files, project: String(p.extra?.project ?? ''), location: String(p.extra?.location ?? '') })
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
    await api.updateProvider(requireId(), { name: form.name, protocol: form.protocol, base_url: form.base_url, enabled: form.enabled, native_files: form.native_files, extra, ...(form.api_key ? { api_key: form.api_key } : {}) })
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

/** The one persistence path for a model row: send the patch, then re-read what the server stored. */
async function applyModel(m: Model, patch: Partial<ModelInput>) {
  try {
    await api.updateModel(requireId(), m.id, patch)
    models.value = await api.models(requireId())
    await config.load()
  } catch (err) { report(err) }
}

async function toggleModel(m: Model, key: 'enabled' | BooleanCapability, value: boolean) {
  await applyModel(m, key === 'enabled' ? { enabled: value } : { capabilities: { ...m.capabilities, [key]: value } })
}

function hasEffort(m: Model, effort: ReasoningEffort): boolean {
  return m.capabilities.reasoning_efforts?.includes(effort) ?? false
}

/**
 * Reasoning levels are declared by the user and never inferred from a model id (spec §4.4).
 * Clearing the last one drops the key instead of storing `[]`: `reasoningStopsFor` and
 * `buildProviderOptions` both read absent *and* empty as "undeclared", which downstream means no
 * restriction rather than nothing allowed, so the undeclared state keeps a single spelling.
 */
async function toggleEffort(m: Model, effort: ReasoningEffort, on: boolean) {
  const next = REASONING_EFFORTS.filter((e) => (e === effort ? on : hasEffort(m, e)))
  const capabilities: ModelCapabilities = { ...m.capabilities }
  if (next.length) capabilities.reasoning_efforts = next
  else delete capabilities.reasoning_efforts
  await applyModel(m, { capabilities })
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
//- Spec §8: the route root is fixed-height and clips; the body below is its only vertical scroll
//- owner, so a provider with many models never hands a scrollbar back to the document.
.h-full.min-h-0.overflow-hidden
  .oc-scroll.h-full.overflow-y-auto
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
              SelectItem(value="vertex-compatible") Google Vertex 兼容
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
        .flex.items-start.gap-2
          Switch(:model-value="form.native_files" @update:model-value="form.native_files = $event")
          div
            Label 支持原生文件转储（Files API）
            p.text-xs.text-muted-foreground 文件临时上传到当前供应商并自动过期；兼容端点未实现 /files 时请勿开启。
        .flex.items-center.gap-2
          Switch(:model-value="form.enabled" @update:model-value="form.enabled = $event")
          Label 启用
      .flex.gap-2
        Button(@click="save") 保存
        Button(variant="secondary" :disabled="!canFetchModels" @click="fetchModels") 从 /models 拉取
        Button(variant="destructive" class="ml-auto" @click="remove") 删除供应商
      p.text-xs.text-muted-foreground(v-if="status") {{ status }}
      h2.font-medium 模型
      p.text-xs.text-muted-foreground
        | 能力全部由这里声明，不会从模型名推断（spec §4.4）。推理档位留空表示未声明，不构成限制。
      .flex.gap-2
        Input(v-model="newModelId" placeholder="model id，例如 gpt-5.1" @keydown.enter="addModel")
        Button(@click="addModel") 添加
      //- Spec §8: the capability grid is wider than a phone, so it gets its own bounded vertical
      //- box with a local horizontal scroller inside it. Neither axis may widen the page, and 保存
      //- / 删除供应商 sit above the box where a long model list can never push them out of reach.
      .oc-scroll.max-h-96.overflow-y-auto.rounded-md.border
        .overflow-x-auto
          table.w-full.text-sm
            thead
              tr.text-left.text-xs.text-muted-foreground
                th.px-2.py-1.whitespace-nowrap 模型
                th.px-2.whitespace-nowrap 启用
                th.px-2.whitespace-nowrap 视觉
                th.px-2.whitespace-nowrap 推理
                th.px-2.whitespace-nowrap 工具
                th.px-2.whitespace-nowrap 图片输出
                th.px-2.whitespace-nowrap 可关闭推理
                th.px-2.whitespace-nowrap 推理档位
                th
            tbody
              tr.border-t.align-top(v-for="m in models" :key="m.id")
                td.px-2.py-2
                  span.whitespace-nowrap {{ m.display_name }}
                  span.ml-1.whitespace-nowrap.text-xs.text-muted-foreground(v-if="m.display_name !== m.model_id") {{ m.model_id }}
                td.px-2.py-2
                  Switch(:model-value="m.enabled" @update:model-value="toggleModel(m, 'enabled', $event)")
                td.px-2.py-2
                  Switch(:model-value="!!m.capabilities.vision" @update:model-value="toggleModel(m, 'vision', $event)")
                td.px-2.py-2
                  Switch(:model-value="!!m.capabilities.reasoning" @update:model-value="toggleModel(m, 'reasoning', $event)")
                td.px-2.py-2
                  Switch(:model-value="!!m.capabilities.tools" @update:model-value="toggleModel(m, 'tools', $event)")
                td.px-2.py-2
                  Switch(:model-value="!!m.capabilities.image_output" @update:model-value="toggleModel(m, 'image_output', $event)")
                td.px-2.py-2
                  Switch(:model-value="!!m.capabilities.reasoning_can_disable" @update:model-value="toggleModel(m, 'reasoning_can_disable', $event)")
                td.px-2.py-2
                  .flex.w-52.flex-wrap.gap-1
                    button(
                      v-for="e in REASONING_EFFORTS" :key="e" type="button"
                      class="rounded border px-1.5 py-0.5 text-xs"
                      :class="hasEffort(m, e) ? 'border-primary bg-accent text-foreground' : 'border-transparent bg-muted text-muted-foreground'"
                      :aria-pressed="hasEffort(m, e)"
                      @click="toggleEffort(m, e, !hasEffort(m, e))") {{ REASONING_LABELS[e] }}
                td.px-2.py-2.text-right
                  button.whitespace-nowrap.text-xs.text-destructive(@click="removeModel(m)") 删除
</template>
