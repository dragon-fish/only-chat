<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue'
import { DownloadIcon, PlusIcon, Settings2Icon, Trash2Icon } from '@lucide/vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ModelEditor from '@/client/components/model-editor.vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import ModelFilterMenu from '@/client/components/model-filter-menu.vue'
import ModelGroupList from '@/client/components/model-group-list.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import ProviderNavigation from '@/client/components/provider-navigation.vue'
import ProviderSettingsForm from '@/client/components/provider-settings-form.vue'
import { api } from '@/client/lib/api'
import { providerSettingsDraft } from '@/client/lib/provider-settings'
import { filterModelEntries, modelBadges, modelName, sortModelEntries } from '@/client/lib/ui-models'
import { createModelWriteQueue } from '@/client/lib/settings'
import { createModelEditorSession, type ModelEditorSession } from '@/client/lib/model-editor'
import { useConfigStore } from '@/client/stores/config'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { ButtonGroup } from '@/client/ui/button-group'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Separator } from '@/client/ui/separator'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import { Switch } from '@/client/ui/switch'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { type ModelListItem, type ModelWithMetadata, type ModelQuery } from '@/shared/models'
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
const models = ref<ModelListItem[]>([])
const modelFilters = ref<Partial<ModelQuery>>({})
const debouncedSearch = ref('')
const hasModelFilters = computed(() => Object.values(modelFilters.value).some(value => value !== undefined && value !== ''))
const filteredModels = computed(() => {
  if (!savedProvider.value) return []
  return sortModelEntries(filterModelEntries(models.value.map(model => ({ provider: savedProvider.value!, model })), {
    ...modelFilters.value, search: debouncedSearch.value || undefined,
  }, false), [savedProvider.value], 'lab').map(entry => entry.model)
})
const visibleModels = computed(() => filteredModels.value)
const modelEntries = computed(() => savedProvider.value ? visibleModels.value.map(model => ({ provider: savedProvider.value!, model })) : [])
const imageModels = computed(() => models.value.filter(model => model.enabled && model.metadata.modalities?.output.includes('image')))
const providerImageModel = computed({
  get: () => form.default_image_model_id ?? '',
  set: (value: string) => { form.default_image_model_id = value || null },
})
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
const editingSession = shallowRef<ModelEditorSession | null>(null)
const modelEditor = ref<InstanceType<typeof ModelEditor> | null>(null)
const editorOpen = ref(false)
const modelToDelete = ref<ModelWithMetadata | null>(null)
const modelDeleteOpen = ref(false)
let editRequestToken = 0
let pendingDraftToken = 0
const pendingModelDrafts = new Map<number, { token: number, patch: Partial<ModelWriteInput> }>()
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
async function readModels(id: number) {
  if (id !== providerId.value) return null
  const token = ++modelLoadToken
  const navigation = loadToken
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  refreshing.value = true
  try {
    const entries = await config.loadProviderModelList(id, controller.signal)
    if (id !== providerId.value || token !== modelLoadToken || navigation !== loadToken) return null
    return entries.map(model => JSON.parse(JSON.stringify(model)) as ModelListItem)
  } catch (error) {
    if (controller.signal.aborted || token !== modelLoadToken || navigation !== loadToken) return null
    throw error
  } finally { if (token === modelLoadToken && navigation === loadToken) refreshing.value = false }
}
async function loadModelPage() {
  const id = providerId.value
  if (id === null) return
  const token = ++modelLoadToken
  const navigation = loadToken
  loadController?.abort()
  const controller = new AbortController()
  loadController = controller
  const invalidContext = modelFilters.value.min_context !== undefined && (!Number.isInteger(modelFilters.value.min_context) || modelFilters.value.min_context < 0)
  if (invalidContext) {
    modelLoadError.value = '最小上下文需要填写非负整数。'
    refreshing.value = false
    return
  }
  refreshing.value = true
  modelLoadError.value = null
  try {
    const entries = await config.loadProviderModelList(id, controller.signal)
    if (token !== modelLoadToken || navigation !== loadToken) return
    models.value = entries.map(model => JSON.parse(JSON.stringify(model)) as ModelListItem)
  } catch (error) {
    if (token === modelLoadToken && navigation === loadToken && !controller.signal.aborted) modelLoadError.value = error instanceof Error ? error.message : String(error)
  } finally { if (token === modelLoadToken && navigation === loadToken) refreshing.value = false }
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(() => modelFilters.value.search, value => {
  if (!ready.value) return
  if (searchTimer) clearTimeout(searchTimer)
  if (!value?.trim()) debouncedSearch.value = ''
  else searchTimer = setTimeout(() => { debouncedSearch.value = value.trim() }, 150)
})
async function load() {
  editRequestToken++
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
      Object.assign(form, providerSettingsDraft(provider))
      markSaved()
      models.value = JSON.parse(JSON.stringify(config.modelsByProvider[provider.id] ?? []))
      modelFilters.value = {}
      debouncedSearch.value = ''
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
onBeforeUnmount(() => { loadToken++; modelLoadToken++; editRequestToken++; loadController?.abort(); if (searchTimer) clearTimeout(searchTimer) })

function updateProviderForm(value: ProviderWriteInput) { Object.assign(form, value) }

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
    config.invalidateProviderModels(id)
    await config.load()
    await Promise.all([
      config.refreshSelectedModels(id),
      token === loadToken ? loadModelPage() : Promise.resolve(),
      config.pickerLoaded ? config.loadEnabledModelList() : Promise.resolve(),
    ])
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

async function setModelsEnabled(enabled: boolean, lab_id?: string | null) {
  if (busyModels.value || deletingProvider.value) return
  const id = requireId()
  const token = loadToken
  modelAction.value = true
  try {
    const result = await api.updateModels(id, { enabled, ...(lab_id !== undefined ? { lab_id } : {}) })
    const loadedModels = await readModels(id)
    const modelToken = modelLoadToken
    await config.load()
    if (token !== loadToken) return
    if (loadedModels && modelToken === modelLoadToken) models.value = loadedModels
    toast.success(`${enabled ? '启用' : '禁用'} ${result.updated} 个模型${result.deleted ? `，移除 ${result.deleted} 个失效模型` : ''}`)
  } catch (error) { report(error) }
  finally { if (token === loadToken) modelAction.value = false }
}

async function setModelEnabled(model: ModelListItem, enabled: boolean) {
  if (enabled || model.manual_pinned || model.upstream_available !== false) {
    await applyModel(model, { enabled })
    return
  }
  if (busyModels.value || deletingProvider.value) return
  modelAction.value = true
  try {
    await api.deleteModel(model.provider_id, model.id)
    config.forgetModel(model)
    models.value = models.value.filter(entry => entry.id !== model.id)
    toast.success('已移除运营商不再提供的模型')
  } catch (error) { report(error) }
  finally { modelAction.value = false }
}

async function refreshWrittenModel(target: Pick<ModelWithMetadata, 'id' | 'provider_id' | 'model_id'>) {
  try {
    const current = await config.refreshModel(target)
    const session = editingSession.value
    if (session?.target.provider_id === target.provider_id && session.target.id === target.id) session.acknowledge(current)
  } catch (error) {
    toast.warning('模型已保存，但元数据刷新失败', {
      id: `model-metadata-${target.provider_id}-${target.id}`,
      description: error instanceof Error ? error.message : String(error),
      action: { label: '重试刷新', onClick: () => { void refreshWrittenModel(target) } },
    })
  }
}

const writeQueues = new Map<number, ReturnType<typeof createModelWriteQueue>>()
function queueFor(id: number) {
  let queue = writeQueues.get(id)
  if (!queue) {
    queue = createModelWriteQueue({
      write: async (modelId, patch) => {
        const record = Object.values(config.modelsByRef).find(model => model.id === modelId && model.provider_id === id)
          ?? Object.values(config.modelListByRef).find(model => model.id === modelId && model.provider_id === id)
        if (!record) throw new Error('missing model record')
        const retainAcknowledgement = config.beginModelWrite(record)
        const result = await api.updateModel(id, modelId, patch)
        const retained = retainAcknowledgement(result)
        const session = editingSession.value
        if (session?.target.provider_id === id && session.target.id === modelId) {
          const cached = config.modelsByRef[`${id}:${result.model_id}`]
          const current = cached?.id === modelId ? cached : session.model
          const { model_id, interface_id, enabled, sort, metadata_override } = result
          // Acknowledge committed settings without restoring effective metadata from an older association.
          session.acknowledge(retained ? result : { ...current, model_id, interface_id, enabled, sort, metadata_override })
        }
        if (!retained) await refreshWrittenModel({ id: modelId, provider_id: id, model_id: result.model_id })
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

async function applyModel(target: Pick<ModelListItem, 'id' | 'provider_id'>, patch: Partial<ModelWriteInput>) {
  modelLoadToken++
  loadController?.abort()
  refreshing.value = false
  // Keep the local row's pending intent isolated from the authoritative Pinia cache.
  const model = models.value.find(model => model.id === target.id && model.provider_id === target.provider_id)
  if (model) {
    Object.assign(model, patch)
    if (patch.metadata_override?.name !== undefined) model.metadata = { ...model.metadata, name: patch.metadata_override.name }
  }
  const id = target.provider_id
  const draftToken = ++pendingDraftToken
  const previousDraft = pendingModelDrafts.get(target.id)?.patch ?? {}
  pendingModelDrafts.set(target.id, { token: draftToken, patch: { ...previousDraft, ...patch } })
  pendingWrites.set(id, (pendingWrites.get(id) ?? 0) + 1)
  try {
    const saved = await queueFor(id)(target.id, patch)
    if (saved) toast.success('已保存模型')
    return saved
  } finally {
    if (pendingModelDrafts.get(target.id)?.token === draftToken) pendingModelDrafts.delete(target.id)
    pendingWrites.set(id, (pendingWrites.get(id) ?? 1) - 1)
  }
}

async function openModel(model: ModelListItem) {
  const request = ++editRequestToken
  const navigation = loadToken
  try {
    const authoritative = await api.modelByRef({ provider_id: model.provider_id, model_id: model.model_id })
    if (request !== editRequestToken || navigation !== loadToken || providerId.value !== model.provider_id) return
    const pending = pendingModelDrafts.get(model.id)?.patch
    const initial = pending ? {
      ...authoritative,
      ...(pending.model_id === undefined ? {} : { model_id: pending.model_id }),
      ...(pending.interface_id === undefined ? {} : { interface_id: pending.interface_id }),
      ...(pending.metadata_override === undefined ? {} : { metadata_override: pending.metadata_override }),
      ...(pending.enabled === undefined ? {} : { enabled: pending.enabled }),
      ...(pending.sort === undefined ? {} : { sort: pending.sort }),
    } : authoritative
    editingSession.value = createModelEditorSession(authoritative, initial)
    editorOpen.value = true
  } catch (error) {
    if (request !== editRequestToken || navigation !== loadToken || providerId.value !== model.provider_id) return
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
      config.forgetModel(model)
      models.value = models.value.filter(entry => entry.id !== model.id)
    }
    report(error)
  }
}

async function saveModel(patch: Partial<ModelWriteInput>) {
  const editor = modelEditor.value
  const session = editingSession.value
  if (!session || !editor) return
  const token = loadToken
  const snapshot = editor.captureSnapshot()
  const saved = await applyModel(session.target, patch)
  // Reopening the same model creates a new draft owner that an earlier save must not close.
  if (!saved || token !== loadToken || modelEditor.value !== editor || editingSession.value !== session) return
  if (editor.matchesSnapshot(snapshot)) editorOpen.value = false
}

function confirmModelDelete() {
  modelToDelete.value = editingSession.value?.model ?? null
  editorOpen.value = false
  modelDeleteOpen.value = true
}

async function removeModel() {
  if (!modelToDelete.value || busyModels.value) return
  const target = { id: modelToDelete.value.id, provider_id: modelToDelete.value.provider_id, model_id: modelToDelete.value.model_id }
  const id = target.provider_id
  const token = loadToken
  modelAction.value = true
  editorOpen.value = false
  try {
    await api.deleteModel(id, target.id)
    config.forgetModel(target)
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
  Teleport(to="#page-header" defer)
    SettingsBackButton(to="/settings/providers" label="返回供应商列表")
    span.truncate.text-sm.font-medium {{ savedName }}
  ProviderNavigation(:selected-provider-id="providerId" class="hidden w-64 shrink-0 border-r md:flex" @catalog-refreshed="load()")
  .oc-scroll.min-h-0.min-w-0.flex-1.overflow-y-auto
    .mx-auto.flex.w-full.max-w-5xl.flex-col.gap-6.p-4.pb-0(class="md:p-6 md:pb-0 lg:p-8 lg:pb-0")
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
        form#provider-settings-form.flex.flex-col.gap-6(@submit.prevent="save")
          ProviderSettingsForm(
            :model-value="form"
            :catalog-providers="catalogProviders"
            :current-catalog-provider-id="savedProvider?.models_dev_provider_id"
            :has-key="hasKey"
            @update:model-value="updateProviderForm")
          Field
            FieldLabel(for="provider-default-image-model") 默认生图模型
            NativeSelect#provider-default-image-model(v-model="providerImageModel" class="w-full")
              NativeSelectOption(value="") 跟随全局默认
              NativeSelectOption(v-for="model in imageModels" :key="model.id" :value="model.model_id") {{ modelName(model) }}
          p.min-h-5.text-sm.text-muted-foreground(role="status") {{ associationWarning ?? '' }}
        Separator
        section.flex.flex-col.gap-4(aria-labelledby="provider-models-title")
          .flex.flex-wrap.items-center.gap-2
            .flex.min-w-0.flex-1.items-center.gap-2
              h2#provider-models-title.text-lg.font-semibold 模型
              Badge(variant="secondary") {{ models.length }}
            Button(type="button" variant="outline" size="sm" class="min-h-10" :disabled="dirty || !canFetchModels || busyModels || deletingProvider" @click="fetchModels")
              DownloadIcon(data-icon="inline-start")
              | {{ modelAction ? '处理中…' : '拉取模型' }}
            Button(type="button" variant="ghost" size="sm" class="min-h-10" :disabled="busyModels || deletingProvider" @click="setModelsEnabled(true)") 全部启用
            Button(type="button" variant="ghost" size="sm" class="min-h-10" :disabled="busyModels || deletingProvider" @click="setModelsEnabled(false)") 全部禁用
          p.text-sm.text-muted-foreground 通过供应商拉取或手动添加模型。目录只提供元数据。
          ModelFilterMenu(v-model="modelFilters" :providers="savedProvider ? [savedProvider] : []" status)
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
            ModelGroupList(:entries="modelEntries" :catalog-providers="catalogProviders" :show-providers="false" collapsible show-single-lab)
              template(#lab-actions="{ lab }")
                Button(type="button" variant="ghost" size="xs" class="min-h-10" :aria-label="`启用 ${lab.id ?? '其他'} 分组`" :disabled="busyModels || deletingProvider" @click="setModelsEnabled(true, lab.id)") 启用
                Button(type="button" variant="ghost" size="xs" class="min-h-10" :aria-label="`禁用 ${lab.id ?? '其他'} 分组`" :disabled="busyModels || deletingProvider" @click="setModelsEnabled(false, lab.id)") 禁用
              template(#default="{ entry: { model, provider } }")
                Item(variant="outline")
                  LabAvatar(:model-id="model.model_id" :lab-id="model.lab_id" :family="model.metadata.family" :provider-name="provider.name" size="sm")
                  ItemContent(class="min-w-0")
                    ItemTitle {{ modelName(model) }}
                    ItemDescription(class="break-all") {{ model.model_id }}
                    .flex.flex-wrap.gap-1
                      Badge(v-for="badge in modelBadges(model)" :key="badge.key" variant="secondary") {{ badge.label }}
                      Badge(v-if="model.manual_pinned" variant="outline") 手动
                      Badge(v-else-if="model.upstream_available === false" variant="outline" class="border-warning text-warning") 运营商已移除
                  ItemActions(class="gap-4")
                    Switch(:model-value="model.enabled" :aria-label="`启用 ${modelName(model)}`" class="after:-inset-y-3" :disabled="modelAction || deletingProvider" @update:model-value="setModelEnabled(model, $event)")
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
        .sticky.bottom-0.-mx-4.flex.items-center.justify-between.gap-3.border-t.p-4.backdrop-blur(data-provider-save-bar class="bg-background/95 pb-[calc(1rem+env(safe-area-inset-bottom))] md:-mx-6 md:px-6 lg:-mx-8 lg:px-8")
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
          .flex.items-center.gap-2(aria-label="供应商操作")
            span.text-sm.text-muted-foreground {{ dirty ? '有未保存的更改' : '更改已保存' }}
            Button(type="submit" form="provider-settings-form" class="min-h-10" :disabled="saving || deletingProvider || !validProvider || !dirty") {{ saving ? '保存中…' : '保存' }}
  ModelEditor(v-if="editorOpen && editingSession && savedProvider && providerId !== null" ref="modelEditor" v-model:open="editorOpen" :key="editingSession.target.id" :session="editingSession" :interfaces="savedProvider.interfaces" :default-interface-id="savedProvider.default_interface_id" :saving="busyModels" @save="saveModel" @delete="confirmModelDelete")
  AlertDialog(v-model:open="modelDeleteOpen")
    AlertDialogContent
      AlertDialogHeader
        AlertDialogTitle 删除 {{ modelToDelete ? modelName(modelToDelete) : '' }}？
        AlertDialogDescription 此模型将从当前供应商中移除。
      AlertDialogFooter
        AlertDialogCancel(class="min-h-10") 取消
        AlertDialogAction(variant="destructive" class="min-h-10" :disabled="busyModels" @click="removeModel") 删除模型
</template>
