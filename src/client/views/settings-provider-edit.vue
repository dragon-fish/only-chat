<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { DownloadIcon, PlusIcon, Settings2Icon, Trash2Icon } from '@lucide/vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ModelEditor from '@/client/components/model-editor.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import ProviderNavigation from '@/client/components/provider-navigation.vue'
import { api } from '@/client/lib/api'
import { createModelWriteQueue } from '@/client/lib/settings'
import { useConfigStore } from '@/client/stores/config'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { ButtonGroup } from '@/client/ui/button-group'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Separator } from '@/client/ui/separator'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import { Switch } from '@/client/ui/switch'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { ProtocolSchema, type Model, type Protocol } from '@/shared/models'
import type { ModelInput } from '@/shared/api'

const props = defineProps<{ providerId: number | null }>()
const router = useRouter()
const config = useConfigStore()
const providerId = computed(() => props.providerId)
const form = reactive({ name: '', protocol: 'openai-completions' as Protocol, base_url: '', api_key: '', enabled: true, native_files: false, project: '', location: '' })
const { dirty, markSaved } = useFormChanges(() => form)
const models = ref<Model[]>([])
const modelQuery = ref('')
const visibleModels = computed(() => {
  const query = modelQuery.value.trim().toLocaleLowerCase()
  return models.value.filter(model => [model.model_id, model.display_name].some(value => value.toLocaleLowerCase().includes(query)))
})
const newModelId = ref('')
function focusNewModel() { document.getElementById('new-model-id')?.focus() }
const loading = ref(true)
const refreshing = ref(false)
const ready = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)
const modelAction = ref(false)
const pendingWrites = reactive(new Map<number, number>())
const deletingProvider = ref(false)
const providerDeleteOpen = ref(false)
const editingModel = ref<Model | null>(null)
const modelEditor = ref<InstanceType<typeof ModelEditor> | null>(null)
const editorOpen = ref(false)
const modelToDelete = ref<Model | null>(null)
const modelDeleteOpen = ref(false)
const busyModels = computed(() => modelAction.value || (pendingWrites.get(providerId.value ?? -1) ?? 0) > 0)
const canFetchModels = computed(() => form.protocol !== 'vertex' && form.protocol !== 'vertex-compatible')
const hasKey = computed(() => config.providers.find(provider => provider.id === providerId.value)?.has_key)
const capabilityLabels = [
  { key: 'vision', label: '视觉' }, { key: 'reasoning', label: '推理' },
  { key: 'tools', label: '工具' }, { key: 'image_output', label: '图片输出' },
] as const

function requireId(): number {
  if (providerId.value === null) throw new Error('missing provider id')
  return providerId.value
}

function report(error: unknown) {
  toast.error(error instanceof Error ? error.message : String(error))
}

let loadToken = 0
let loadedProviderId: number | null = null
let loadController: AbortController | undefined
async function load() {
  const id = providerId.value
  const token = ++loadToken
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  loading.value = !ready.value
  refreshing.value = true
  loadError.value = null
  try {
    if (!config.loaded) await config.load()
    if (token !== loadToken) return
    const provider = config.providers.find(item => item.id === id)
    if (!provider) { await router.replace('/settings/providers'); return }
    if (loadedProviderId !== id) {
      Object.assign(form, {
        name: provider.name, protocol: provider.protocol, base_url: provider.base_url, api_key: '',
        enabled: provider.enabled, native_files: provider.native_files,
        project: String(provider.extra?.project ?? ''), location: String(provider.extra?.location ?? ''),
      })
      markSaved()
      models.value = config.modelsByProvider[provider.id] ?? []
      modelQuery.value = ''
      newModelId.value = ''
      editorOpen.value = false
      saving.value = modelAction.value = deletingProvider.value = false
      loadedProviderId = id
    }
    ready.value = true
    loading.value = false
    const result = await api.models(provider.id, controller.signal)
    if (token === loadToken) models.value = result
  } catch (error) {
    if (token === loadToken && !controller.signal.aborted) loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (token === loadToken) { loading.value = false; refreshing.value = false }
  }
}
watch(providerId, load, { immediate: true })
onBeforeUnmount(() => { loadToken++; loadController?.abort() })

function onProtocolChange(value: unknown) {
  const parsed = ProtocolSchema.safeParse(value)
  if (parsed.success) form.protocol = parsed.data
}

async function save() {
  if (saving.value) return
  const id = requireId()
  const token = loadToken
  const submitted = { ...form }
  saving.value = true
  try {
    // The server clears extra when protocol arrives without it, so always send both.
    const extra = submitted.protocol === 'vertex' ? { project: submitted.project, location: submitted.location } : null
    await api.updateProvider(id, {
      name: submitted.name, protocol: submitted.protocol, base_url: submitted.base_url, enabled: submitted.enabled,
      native_files: submitted.native_files, extra, ...(submitted.api_key ? { api_key: submitted.api_key } : {}),
    })
    await config.load()
    if (token === loadToken) {
      if (form.api_key === submitted.api_key) form.api_key = ''
      markSaved(JSON.stringify({ ...submitted, api_key: '' }))
      toast.success('已保存供应商')
    }
  } catch (error) { report(error) }
  finally { if (token === loadToken) saving.value = false }
}

async function remove() {
  if (busyModels.value || deletingProvider.value) return
  const id = requireId()
  const token = loadToken
  deletingProvider.value = true
  try {
    await api.deleteProvider(id)
    await config.load()
    toast.success('已删除供应商')
    if (token === loadToken) { markSaved(); await router.push('/settings/providers') }
  } catch (error) { report(error) }
  finally { if (token === loadToken) deletingProvider.value = false }
}

async function fetchModels() {
  if (!canFetchModels.value || busyModels.value) return
  const id = requireId()
  const token = loadToken
  modelAction.value = true
  try {
    const result = await api.fetchModels(id)
    const loadedModels = await api.models(id)
    await config.load()
    if (token !== loadToken) return
    models.value = loadedModels
    toast.success(`导入 ${result.imported} 个新模型`)
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}

async function addModel() {
  const model_id = newModelId.value.trim()
  if (!model_id || busyModels.value) return
  const id = requireId()
  const token = loadToken
  modelAction.value = true
  try {
    await api.createModel(id, { model_id })
    const loadedModels = await api.models(id)
    await config.load()
    if (token !== loadToken) return
    newModelId.value = ''
    models.value = loadedModels
    toast.success('已添加模型')
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}

const writeQueues = new Map<number, ReturnType<typeof createModelWriteQueue>>()
function queueFor(id: number) {
  let queue = writeQueues.get(id)
  if (!queue) {
    queue = createModelWriteQueue({
      write: (modelId, patch) => api.updateModel(id, modelId, patch),
      read: async () => {
        const result = await api.models(id)
        await config.load()
        return result
      },
      apply: result => { if (providerId.value === id) models.value = result },
      onError: report,
    })
    writeQueues.set(id, queue)
  }
  return queue
}

async function applyModel(model: Model, patch: Partial<ModelInput>) {
  // Apply intent before enqueueing: the next edit must build on the latest capabilities.
  Object.assign(model, patch)
  const id = model.provider_id
  pendingWrites.set(id, (pendingWrites.get(id) ?? 0) + 1)
  try {
    const saved = await queueFor(id)(model.id, patch)
    if (saved) toast.success('已保存模型')
    return saved
  } finally { pendingWrites.set(id, (pendingWrites.get(id) ?? 1) - 1) }
}

function openModel(model: Model) {
  editingModel.value = model
  editorOpen.value = true
}

async function saveModel(patch: Partial<ModelInput>) {
  const editor = modelEditor.value
  if (!editingModel.value || !editor) return
  const current = models.value.find(model => model.id === editingModel.value?.id)
  if (!current) return
  const token = loadToken
  const snapshot = editor.captureSnapshot()
  const saved = await applyModel(current, patch)
  // Reopening the same model creates a new draft owner that an earlier save must not close.
  if (!saved || token !== loadToken || modelEditor.value !== editor) return
  if (editor.acknowledgeSave(snapshot)) editorOpen.value = false
}

function confirmModelDelete() {
  modelToDelete.value = editingModel.value
  modelDeleteOpen.value = true
}

async function removeModel() {
  if (!modelToDelete.value || busyModels.value) return
  const id = requireId()
  const token = loadToken
  const modelId = modelToDelete.value.id
  modelAction.value = true
  editorOpen.value = false
  try {
    await api.deleteModel(id, modelId)
    const loadedModels = await api.models(id)
    await config.load()
    if (token !== loadToken) return
    models.value = loadedModels
    toast.success('已删除模型')
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}
</script>

<template lang="pug">
.flex.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    SettingsBackButton(to="/settings/providers" label="返回供应商列表")
    span.truncate.text-sm.font-medium {{ form.name || '供应商设置' }}
  ProviderNavigation(:selected-provider-id="providerId" class="hidden w-64 shrink-0 border-r md:flex")
  .oc-scroll.min-h-0.min-w-0.flex-1.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        .flex.h-10.items-center.gap-3
          .flex.min-w-0.flex-1.items-center.gap-2
            h1.truncate.text-2xl.font-semibold(:title="form.name || '供应商设置'") {{ form.name || '供应商设置' }}
            UnsavedChangesGuard(:dirty="dirty")
            Spinner(v-if="refreshing && ready" class="shrink-0" aria-label="正在更新模型列表" title="正在更新模型列表")
          Switch#provider-enabled(v-if="ready" v-model="form.enabled" aria-label="启用供应商" class="after:-inset-y-3")
        .flex.flex-wrap.gap-1(v-if="ready")
          Badge(:variant="form.enabled ? 'secondary' : 'outline'") {{ form.enabled ? '已启用' : '已停用' }}
          Badge(variant="outline") {{ hasKey ? '已配置密钥' : '无密钥' }}
      .flex.flex-col.gap-4(v-if="loading" aria-label="正在加载供应商")
        Skeleton(class="h-8 w-40")
        Skeleton(v-for="index in 5" :key="index" class="h-16 w-full")
      Alert(v-else-if="!ready || loadError" variant="destructive")
        AlertTitle 无法加载供应商
        AlertDescription
          p {{ loadError }}
          Button(variant="outline" class="min-h-10" @click="load") 重试
      template(v-else)
        form.flex.flex-col.gap-6(@submit.prevent="save")
          FieldGroup
            Field
              FieldLabel(for="provider-name") 名称
              Input#provider-name(v-model="form.name" required maxlength="100" class="min-h-10")
            Field
              FieldLabel(for="provider-protocol") 协议
              Select(:model-value="form.protocol" @update:model-value="onProtocolChange")
                SelectTrigger#provider-protocol(class="min-h-10 w-full")
                  SelectValue
                SelectContent
                  SelectGroup
                    SelectItem(value="openai-completions" class="min-h-10") OpenAI Chat Completions（含兼容中转）
                    SelectItem(value="openai-responses" class="min-h-10") OpenAI Responses
                    SelectItem(value="anthropic" class="min-h-10") Anthropic Messages
                    SelectItem(value="vertex" class="min-h-10") Google Vertex AI
                    SelectItem(value="vertex-compatible" class="min-h-10") Google Vertex 兼容
            Field
              FieldLabel(for="provider-url") Base URL
              Input#provider-url(v-model="form.base_url" type="url" required placeholder="https://api.example.com/v1" class="min-h-10")
            Field
              FieldLabel(for="provider-key") {{ form.protocol === 'vertex' ? '服务账号 JSON' : 'API Key' }}
              Input#provider-key(v-model="form.api_key" type="password" autocomplete="off" placeholder="留空保持不变" class="min-h-10")
              FieldDescription 留空保留已配置的密钥。
            template(v-if="form.protocol === 'vertex'")
              Field
                FieldLabel(for="provider-project") Project
                Input#provider-project(v-model="form.project" class="min-h-10")
              Field
                FieldLabel(for="provider-location") Location
                Input#provider-location(v-model="form.location" placeholder="us-central1 / global" class="min-h-10")
            Field(orientation="horizontal" class="min-h-10")
              FieldContent
                FieldLabel(for="provider-files") 支持原生文件转储
                FieldDescription 文件临时上传到当前供应商并自动过期；请确认端点支持 Files API。
              Switch#provider-files(v-model="form.native_files" class="after:-inset-y-3")
          .flex.flex-wrap.items-center.justify-between.gap-2
            ButtonGroup(aria-label="供应商操作")
              Button(type="submit" class="min-h-10" :disabled="saving || deletingProvider") {{ saving ? '保存中…' : '保存' }}
              Button(type="button" variant="outline" class="min-h-10" :disabled="!canFetchModels || busyModels || deletingProvider" @click="fetchModels")
                DownloadIcon(data-icon="inline-start")
                | {{ modelAction ? '处理中…' : '拉取模型' }}
            AlertDialog(v-model:open="providerDeleteOpen")
              AlertDialogTrigger(as-child)
                Button(type="button" variant="ghost" size="icon" class="size-10" aria-label="删除供应商" :disabled="busyModels || deletingProvider || saving")
                  Trash2Icon
              AlertDialogContent
                AlertDialogHeader
                  AlertDialogTitle 删除 {{ form.name }}？
                  AlertDialogDescription 此供应商及其模型配置将被删除。
                AlertDialogFooter
                  AlertDialogCancel(class="min-h-10") 取消
                  AlertDialogAction(variant="destructive" class="min-h-10" :disabled="busyModels || deletingProvider" @click="remove") 删除供应商
        Separator
        section.flex.flex-col.gap-4(aria-labelledby="provider-models-title")
          .flex.items-center.gap-2
            h2#provider-models-title.text-lg.font-semibold 模型
            Badge(variant="secondary") {{ models.length }}
          p.text-sm.text-muted-foreground 管理可用模型。点击设置调整名称、能力与推理档位。
          FieldGroup
            Field
              FieldLabel.sr-only(for="provider-model-search") 搜索模型
              Input#provider-model-search(v-model="modelQuery" type="search" aria-label="搜索模型" placeholder="搜索模型 ID 或名称…" class="min-h-10")
          form(@submit.prevent="addModel")
            FieldGroup
              Field
                FieldLabel.sr-only(for="new-model-id") 新模型 ID
                ButtonGroup(class="w-full" aria-label="添加模型")
                  Input#new-model-id(v-model="newModelId" placeholder="模型 ID，例如 gpt-5.1" class="min-h-10 min-w-0" :disabled="modelAction")
                  Button(type="submit" variant="outline" class="min-h-10" :disabled="!newModelId.trim() || busyModels || deletingProvider")
                    PlusIcon(data-icon="inline-start")
                    | 添加
          ItemGroup(class="gap-2")
            Item(v-for="model in visibleModels" :key="model.id" variant="outline")
              ItemContent(class="min-w-0")
                ItemTitle {{ model.display_name }}
                ItemDescription(class="break-all") {{ model.model_id }}
                .flex.flex-wrap.gap-1
                  template(v-for="capability in capabilityLabels" :key="capability.key")
                    Badge(v-if="model.capabilities[capability.key]" variant="secondary") {{ capability.label }}
              ItemActions(class="gap-4")
                Switch(:model-value="model.enabled" :aria-label="`启用 ${model.display_name}`" class="after:-inset-y-3" :disabled="modelAction || deletingProvider" @update:model-value="applyModel(model, { enabled: $event })")
                Button(variant="ghost" size="icon" class="size-10" :aria-label="`编辑 ${model.display_name}`" :disabled="modelAction || deletingProvider" @click="openModel(model)")
                  Settings2Icon
            Empty(v-if="!visibleModels.length")
              EmptyHeader
                EmptyTitle {{ modelQuery.trim() ? '没有匹配的模型' : '尚未添加模型' }}
                EmptyDescription {{ modelQuery.trim() ? '试试其他模型 ID 或名称。' : canFetchModels ? '从供应商拉取模型，或输入模型 ID 手动添加。' : '输入模型 ID，添加此供应商支持的模型。' }}
              EmptyContent
                Button(v-if="modelQuery.trim()" variant="outline" class="min-h-10" @click="modelQuery = ''") 清除搜索
                Button(v-else-if="canFetchModels" variant="outline" class="min-h-10" :disabled="busyModels || deletingProvider" @click="fetchModels") 拉取模型
                Button(v-else variant="outline" class="min-h-10" @click="focusNewModel") 输入模型 ID
  ModelEditor(v-if="editorOpen && editingModel && providerId !== null" ref="modelEditor" v-model:open="editorOpen" :key="editingModel.id" :provider-id="providerId" :model="editingModel" :saving="busyModels" @save="saveModel" @delete="confirmModelDelete")
  AlertDialog(v-model:open="modelDeleteOpen")
    AlertDialogContent
      AlertDialogHeader
        AlertDialogTitle 删除 {{ modelToDelete?.display_name }}？
        AlertDialogDescription 此模型将从当前供应商中移除。
      AlertDialogFooter
        AlertDialogCancel(class="min-h-10") 取消
        AlertDialogAction(variant="destructive" class="min-h-10" :disabled="busyModels" @click="removeModel") 删除模型
</template>
