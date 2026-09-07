<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { DownloadIcon, PlusIcon, Settings2Icon, Trash2Icon } from '@lucide/vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ModelEditor from '@/client/components/model-editor.vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import ModelFilterBar from '@/client/components/model-filter-bar.vue'
import ModelGroupList from '@/client/components/model-group-list.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import ProviderNavigation from '@/client/components/provider-navigation.vue'
import ProviderInterfaceList from '@/client/components/provider-interface-list.vue'
import { api } from '@/client/lib/api'
import { modelBadges, modelName } from '@/client/lib/ui-models'
import { createModelWriteQueue } from '@/client/lib/settings'
import { useConfigStore } from '@/client/stores/config'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { ButtonGroup } from '@/client/ui/button-group'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
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
import { type ModelWithMetadata, type ModelQuery } from '@/shared/models'
import { ProviderWriteInputSchema, type CatalogProviderSummary, type ModelWriteInput, type ProviderWriteInput } from '@/shared/api'

const props = defineProps<{ providerId: number | null }>()
const router = useRouter()
const config = useConfigStore()
const providerId = computed(() => props.providerId)
const form = reactive<ProviderWriteInput>({ name: '', api_key: '', enabled: true, interfaces: [], default_protocol: 'chat-completions', models_dev_provider: { source: 'endpoint' } })
const validProvider = computed(() => ProviderWriteInputSchema.safeParse(form).success)
const savedProvider = computed(() => config.providerRecords.find(provider => provider.id === providerId.value))
const savedName = computed(() => savedProvider.value?.name || '供应商设置')
const catalogProviders = ref<CatalogProviderSummary[]>([])
const associationWarning = ref<string | null>(null)
const { dirty, markSaved } = useFormChanges(() => form)
const models = ref<ModelWithMetadata[]>([])
const modelFilters = ref<Partial<ModelQuery>>({})
const modelQuery = computed(() => modelFilters.value.search ?? '')
const hasModelFilters = computed(() => Object.values(modelFilters.value).some(value => value !== undefined && value !== ''))
const visibleModels = computed(() => models.value)
const modelEntries = computed(() => savedProvider.value ? models.value.map(model => ({ provider: savedProvider.value!, model })) : [])
const nextCursor = ref<string | null>(null)
const modelLoadError = ref<string | null>(null)
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
const editingModel = ref<ModelWithMetadata | null>(null)
const modelEditor = ref<InstanceType<typeof ModelEditor> | null>(null)
const editorOpen = ref(false)
const modelToDelete = ref<ModelWithMetadata | null>(null)
const modelDeleteOpen = ref(false)
const busyModels = computed(() => modelAction.value || (pendingWrites.get(providerId.value ?? -1) ?? 0) > 0)
const canFetchModels = computed(() => savedProvider.value?.interfaces.find(endpoint => endpoint.id === savedProvider.value?.default_interface_id)?.protocol !== 'vertex-compatible' && !!savedProvider.value?.default_interface_id)
const hasKey = computed(() => config.providers.find(provider => provider.id === providerId.value)?.has_key)

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
let modelLoadToken = 0
function queryFor(id: number): Partial<ModelQuery> {
  const search = id === providerId.value ? modelQuery.value.trim() : ''
  return id === providerId.value ? { ...modelFilters.value, search: search || undefined } : {}
}
async function readModels(id: number) {
  if (id !== providerId.value) return null
  const token = ++modelLoadToken
  const navigation = loadToken
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  refreshing.value = true
  try {
    const page = await config.loadProviderPage(id, queryFor(id), controller.signal)
    if (id !== providerId.value || token !== modelLoadToken || navigation !== loadToken) return null
    nextCursor.value = page.next_cursor
    return page.models.map(model => JSON.parse(JSON.stringify(model)) as ModelWithMetadata)
  } catch (error) {
    if (controller.signal.aborted || token !== modelLoadToken || navigation !== loadToken) return null
    throw error
  } finally { if (token === modelLoadToken && navigation === loadToken) refreshing.value = false }
}
async function loadModelPage(append = false) {
  const id = providerId.value
  if (id === null) return
  const token = ++modelLoadToken
  const navigation = loadToken
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const search = modelQuery.value.trim()
  const invalidContext = modelFilters.value.min_context !== undefined && (!Number.isInteger(modelFilters.value.min_context) || modelFilters.value.min_context < 0)
  if ((search && Array.from(search).length < 3) || invalidContext) {
    models.value = []
    nextCursor.value = null
    modelLoadError.value = invalidContext ? '最小上下文需要填写非负整数。' : '搜索模型至少需要 3 个字符。'
    refreshing.value = false
    return
  }
  refreshing.value = true
  modelLoadError.value = null
  try {
    const page = await config.loadProviderPage(id, { ...queryFor(id), ...(append && nextCursor.value ? { cursor: nextCursor.value } : {}) }, controller.signal)
    if (token !== modelLoadToken || navigation !== loadToken) return
    const result = page.models.map(model => JSON.parse(JSON.stringify(model)) as ModelWithMetadata)
    models.value = append ? [...models.value, ...result.filter(model => !models.value.some(existing => existing.id === model.id))] : result
    nextCursor.value = page.next_cursor
  } catch (error) {
    if (token === modelLoadToken && navigation === loadToken && !controller.signal.aborted) modelLoadError.value = error instanceof Error ? error.message : String(error)
  } finally { if (token === modelLoadToken && navigation === loadToken) refreshing.value = false }
}
watch(modelFilters, () => {
  if (!ready.value) return
  models.value = []
  nextCursor.value = null
  void loadModelPage()
}, { deep: true })
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
    const provider = config.providerRecords.find(item => item.id === id)
    if (!provider) { await router.replace('/settings/providers'); return }
    if (loadedProviderId !== id) {
      Object.assign(form, {
        name: provider.name, api_key: '', enabled: provider.enabled,
        interfaces: provider.interfaces.map(({ id, protocol, base_url, native_files }) => ({ id, protocol, base_url, native_files })),
        default_protocol: provider.interfaces.find(endpoint => endpoint.id === provider.default_interface_id)?.protocol ?? 'chat-completions',
        models_dev_provider: provider.models_dev_provider_source === 'manual' && provider.models_dev_provider_id ? { source: 'manual', provider_id: provider.models_dev_provider_id } : { source: 'endpoint' },
      })
      markSaved()
      models.value = JSON.parse(JSON.stringify(config.modelsByProvider[provider.id] ?? []))
      modelFilters.value = {}
      newModelId.value = ''
      editorOpen.value = false
      saving.value = modelAction.value = deletingProvider.value = false
      loadedProviderId = id
      associationWarning.value = null
    }
    ready.value = true
    loading.value = false
    await loadModelPage()
    const entries = await api.catalogProviders()
    if (token === loadToken) catalogProviders.value = entries
  } catch (error) {
    if (token === loadToken && !controller.signal.aborted) loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (token === loadToken) { loading.value = false; refreshing.value = false }
  }
}
watch(providerId, load, { immediate: true })
onBeforeUnmount(() => { loadToken++; modelLoadToken++; loadController?.abort() })

function chooseAssociation(value: unknown) {
  if (typeof value !== 'string') return
  form.models_dev_provider = value === 'endpoint' ? { source: 'endpoint' } : { source: 'manual', provider_id: value }
}

async function save() {
  if (saving.value || !validProvider.value) return
  const id = requireId()
  const token = loadToken
  const submitted: ProviderWriteInput = JSON.parse(JSON.stringify(form))
  saving.value = true
  try {
    let responseWarning: string | null = null
    const result = await api.updateProvider(id, { ...submitted, api_key: submitted.api_key || undefined }, value => { responseWarning = value })
    if (token === loadToken) associationWarning.value = responseWarning
    await config.load()
    if (token === loadToken) {
      for (const endpoint of submitted.interfaces) {
        const persisted = result.interfaces.find(entry => entry.protocol === endpoint.protocol)
        const current = form.interfaces.find(entry => entry.protocol === endpoint.protocol)
        if (persisted) {
          endpoint.id = persisted.id
          if (current) current.id = persisted.id
        }
      }
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
    const loadedModels = await readModels(id)
    const modelToken = modelLoadToken
    await config.load()
    if (token !== loadToken) return
    if (loadedModels && modelToken === modelLoadToken) models.value = loadedModels
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
    const loadedModels = await readModels(id)
    const modelToken = modelLoadToken
    await config.load()
    if (token !== loadToken) return
    newModelId.value = ''
    if (loadedModels && modelToken === modelLoadToken) models.value = loadedModels
    toast.success('已添加模型')
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}

const writeQueues = new Map<number, ReturnType<typeof createModelWriteQueue>>()
function queueFor(id: number) {
  let queue = writeQueues.get(id)
  if (!queue) {
    queue = createModelWriteQueue({
      write: async (modelId, patch) => {
        const record = Object.values(config.modelsByRef).find(model => model.id === modelId && model.provider_id === id)
        if (!record) throw new Error('missing model record')
        const result = await api.updateModel(id, modelId, patch)
        if (record.model_id !== result.model_id) config.forgetModel(record)
        config.retainModels([result])
      },
      read: async () => {
        const result = await readModels(id)
        const token = modelLoadToken
        await config.load()
        return token === modelLoadToken ? result : null
      },
      apply: result => { if (providerId.value === id) models.value = result },
      onError: report,
    })
    writeQueues.set(id, queue)
  }
  return queue
}

async function applyModel(model: ModelWithMetadata, patch: Partial<ModelWriteInput>) {
  modelLoadToken++
  loadController?.abort()
  refreshing.value = false
  // Keep the local row's pending intent isolated from the authoritative Pinia cache.
  Object.assign(model, patch)
  if (patch.metadata_override?.name !== undefined) model.metadata = { ...model.metadata, name: patch.metadata_override.name }
  const id = model.provider_id
  pendingWrites.set(id, (pendingWrites.get(id) ?? 0) + 1)
  try {
    const saved = await queueFor(id)(model.id, patch)
    if (saved) toast.success('已保存模型')
    return saved
  } finally { pendingWrites.set(id, (pendingWrites.get(id) ?? 1) - 1) }
}

function openModel(model: ModelWithMetadata) {
  editingModel.value = model
  editorOpen.value = true
}

async function saveModel(patch: Partial<ModelWriteInput>) {
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
    if (modelToDelete.value) config.forgetModel(modelToDelete.value)
    const loadedModels = await readModels(id)
    const modelToken = modelLoadToken
    await config.load()
    if (token !== loadToken) return
    if (loadedModels && modelToken === modelLoadToken) models.value = loadedModels
    toast.success('已删除模型')
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}
</script>

<template lang="pug">
.flex.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    SettingsBackButton(to="/settings/providers" label="返回供应商列表")
    span.truncate.text-sm.font-medium {{ savedName }}
  ProviderNavigation(:selected-provider-id="providerId" class="hidden w-64 shrink-0 border-r md:flex" @catalog-refreshed="load()")
  .oc-scroll.min-h-0.min-w-0.flex-1.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        .flex.h-10.items-center.gap-3
          .flex.min-w-0.flex-1.items-center.gap-2
            h1.truncate.text-2xl.font-semibold(:title="savedName") {{ savedName }}
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
              FieldLabel(for="provider-key") API Key
              Input#provider-key(v-model="form.api_key" type="password" autocomplete="off" placeholder="留空保持不变" class="min-h-10")
              FieldDescription 留空保留已配置的密钥。
            Field
              FieldLabel(for="provider-association") models.dev 关联
              Select(:model-value="form.models_dev_provider?.source === 'manual' ? form.models_dev_provider.provider_id : 'endpoint'" @update:model-value="chooseAssociation")
                SelectTrigger#provider-association(class="w-full")
                  SelectValue
                SelectContent
                  SelectGroup
                    SelectItem(value="endpoint") 按端点自动匹配
                    SelectItem(v-for="entry in catalogProviders" :key="entry.id" :value="entry.id") {{ entry.name }}
              FieldDescription {{ form.models_dev_provider?.source === 'manual' ? '手动关联将保留，不受端点修改影响。' : `保存时按默认端点和同源接口匹配。当前关联：${savedProvider?.models_dev_provider_id ?? '未匹配'}` }}
            ProviderInterfaceList(v-model="form.interfaces" v-model:default-protocol="form.default_protocol")
            p.min-h-5.text-sm.text-muted-foreground(role="status") {{ associationWarning ?? '' }}
          .flex.flex-wrap.items-center.justify-between.gap-2
            ButtonGroup(aria-label="供应商操作")
              Button(type="submit" class="min-h-10" :disabled="saving || deletingProvider || !validProvider") {{ saving ? '保存中…' : '保存' }}
              Button(type="button" variant="outline" class="min-h-10" :disabled="dirty || !canFetchModels || busyModels || deletingProvider" @click="fetchModels")
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
          p.text-sm.text-muted-foreground 通过供应商拉取或手动添加模型。目录只提供元数据。
          ModelFilterBar(v-model="modelFilters" :providers="savedProvider ? [savedProvider] : []")
          p.min-h-5.text-sm.text-muted-foreground(role="status") {{ modelLoadError ?? '' }}
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
            ModelGroupList(:entries="modelEntries" :catalog-providers="catalogProviders" :show-providers="false")
              template(#default="{ entry: { model, provider } }")
                Item(variant="outline")
                  LabAvatar(:lab-id="model.lab_id" :provider-name="provider.name" size="sm")
                  ItemContent(class="min-w-0")
                    ItemTitle {{ modelName(model) }}
                    ItemDescription(class="break-all") {{ model.model_id }}
                    .flex.flex-wrap.gap-1
                      Badge(v-for="badge in modelBadges(model)" :key="badge.key" variant="secondary") {{ badge.label }}
                  ItemActions(class="gap-4")
                    Switch(:model-value="model.enabled" :aria-label="`启用 ${modelName(model)}`" class="after:-inset-y-3" :disabled="modelAction || deletingProvider" @update:model-value="applyModel(model, { enabled: $event })")
                    Button(variant="ghost" size="icon" class="size-10" :aria-label="`编辑 ${modelName(model)}`" :disabled="modelAction || deletingProvider" @click="openModel(model)")
                      Settings2Icon
            template(v-if="refreshing && !visibleModels.length")
              Skeleton(v-for="index in 3" :key="index" class="h-16 w-full")
            Empty(v-else-if="!visibleModels.length")
              EmptyHeader
                EmptyTitle {{ hasModelFilters ? '没有匹配的模型' : '尚未添加模型' }}
                EmptyDescription {{ hasModelFilters ? '试试其他筛选条件。' : canFetchModels ? '从供应商拉取模型，或输入模型 ID 手动添加。' : '输入模型 ID，添加此供应商支持的模型。' }}
              EmptyContent
                Button(v-if="hasModelFilters" variant="outline" class="min-h-10" @click="modelFilters = {}") 清除筛选
                Button(v-else-if="canFetchModels" variant="outline" class="min-h-10" :disabled="dirty || busyModels || deletingProvider" @click="fetchModels") 拉取模型
                Button(v-else variant="outline" class="min-h-10" @click="focusNewModel") 输入模型 ID
          Button(v-if="nextCursor" variant="outline" :disabled="refreshing || busyModels" @click="loadModelPage(true)") 加载更多模型
  ModelEditor(v-if="editorOpen && editingModel && savedProvider && providerId !== null" ref="modelEditor" v-model:open="editorOpen" :key="editingModel.id" :provider-id="providerId" :model="editingModel" :interfaces="savedProvider.interfaces" :default-interface-id="savedProvider.default_interface_id" :saving="busyModels" @save="saveModel" @delete="confirmModelDelete")
  AlertDialog(v-model:open="modelDeleteOpen")
    AlertDialogContent
      AlertDialogHeader
        AlertDialogTitle 删除 {{ modelToDelete ? modelName(modelToDelete) : '' }}？
        AlertDialogDescription 此模型将从当前供应商中移除。
      AlertDialogFooter
        AlertDialogCancel(class="min-h-10") 取消
        AlertDialogAction(variant="destructive" class="min-h-10" :disabled="busyModels" @click="removeModel") 删除模型
</template>
