<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ImagePlusIcon, ImagesIcon, LoaderCircleIcon, SlidersHorizontalIcon, SparklesIcon, XIcon } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ImageParameters from '@/client/components/image-parameters.vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { api } from '@/client/lib/api'
import { buildImageRunInput, isStudioImageModel } from '@/client/lib/image-studio'
import { uploadImage } from '@/client/lib/image-prep'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Card, CardContent } from '@/client/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/client/ui/input-group'
import { ScrollArea } from '@/client/ui/scroll-area'
import { Skeleton } from '@/client/ui/skeleton'
import type { ArtifactDto, ArtifactRunDto } from '@/shared/artifacts'
import type { Conversation } from '@/shared/models'

interface ReferenceImage { attachmentId: number; preview: string }
const props = defineProps<{ conversationId: number | null }>()
const config = useConfigStore()
const sync = useSyncStore()
const route = useRoute()
const router = useRouter()
const conversations = ref<Conversation[]>([])
const runs = ref<ArtifactRunDto[]>([])
const outputs = ref<ArtifactDto[]>([])
const loading = ref(true)
const submitting = ref(false)
const parametersOpen = ref(false)
const prompt = ref('')
const modelKey = ref('')
const count = ref(1)
const customSize = ref(false)
const width = ref(1024)
const height = ref(1024)
const quality = ref('')
const background = ref('')
const outputFormat = ref('')
const references = ref<ReferenceImage[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | undefined

const entries = computed(() => config.enabledModels().filter(entry => isStudioImageModel(entry.provider, entry.model)))
const modelOptions = computed(() => entries.value.map(entry => ({
  key: `${entry.provider.id}:${entry.model.model_id}`,
  label: `${entry.model.metadata.name ?? entry.model.model_id} · ${entry.provider.name}`,
})))
const selectedEntry = computed(() => entries.value.find(entry => `${entry.provider.id}:${entry.model.model_id}` === modelKey.value))
const latestRun = computed(() => runs.value[0])
const running = computed(() => latestRun.value && ['queued', 'running'].includes(latestRun.value.status))
const referenceAllowed = computed(() => selectedEntry.value?.model.metadata.modalities?.input.includes('image') === true)
const canSubmit = computed(() => Boolean(modelKey.value && prompt.value.trim() && !submitting.value && !running.value && (!references.value.length || referenceAllowed.value)))

function parseModel() {
  const separator = modelKey.value.indexOf(':')
  if (separator < 1) return null
  return { provider_id: Number(modelKey.value.slice(0, separator)), model_id: modelKey.value.slice(separator + 1) }
}
function releaseReferences() {
  for (const image of references.value) URL.revokeObjectURL(image.preview)
  references.value = []
}
async function addFiles(files: File[]) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    try {
      const uploaded = await uploadImage(file)
      references.value.push({ attachmentId: uploaded.attachment_id, preview: uploaded.preview })
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  }
}
function chooseFiles() { fileInput.value?.click() }
function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  void addFiles([...(input.files ?? [])])
  input.value = ''
}
function removeReference(index: number) {
  const [removed] = references.value.splice(index, 1)
  if (removed) URL.revokeObjectURL(removed.preview)
}
function applyArtifactDraft(artifact: ArtifactDto, edit: boolean) {
  prompt.value = artifact.prompt
  if (artifact.provider_id !== null) modelKey.value = `${artifact.provider_id}:${artifact.model_id}`
  count.value = artifact.params.count
  customSize.value = artifact.params.size !== null
  width.value = artifact.params.size?.width ?? 1024
  height.value = artifact.params.size?.height ?? 1024
  quality.value = artifact.params.quality ?? ''
  background.value = artifact.params.background ?? ''
  outputFormat.value = artifact.params.output_format ?? ''
  if (edit) references.value.push({ attachmentId: artifact.attachment_id, preview: api.artifactContentUrl(artifact.id) })
}
async function loadModels() {
  if (!config.loaded) await config.load()
  await config.loadEnabledModels(false, { image_output: true })
  if (!modelKey.value) {
    const current = props.conversationId === null ? undefined : conversations.value.find(item => item.id === props.conversationId)
    const preferred = current?.image_provider_id && current.image_model_id
      ? { provider_id: current.image_provider_id, model_id: current.image_model_id }
      : sync.settings.image_model ?? undefined
    const preferredKey = preferred ? `${preferred.provider_id}:${preferred.model_id}` : ''
    modelKey.value = modelOptions.value.some(item => item.key === preferredKey) ? preferredKey : modelOptions.value[0]?.key ?? ''
  }
}
async function loadConversationData() {
  if (props.conversationId === null) { runs.value = []; outputs.value = []; return }
  const [nextRuns, page] = await Promise.all([api.artifactRuns(props.conversationId), api.artifacts({ conversation_id: props.conversationId, limit: 100 })])
  runs.value = nextRuns
  outputs.value = page.artifacts
}
async function load() {
  loading.value = true
  try {
    conversations.value = await api.imageConversations()
    await Promise.all([loadModels(), loadConversationData()])
    if (latestRun.value && (latestRun.value.status === 'queued' || latestRun.value.status === 'running')) void poll(latestRun.value.id)
    const source = Number(route.query.source)
    if (props.conversationId === null && Number.isInteger(source) && source > 0) {
      const artifact = await api.artifact(source)
      if (artifact.provider_id !== null) await config.ensureModel({ provider_id: artifact.provider_id, model_id: artifact.model_id })
      const matching = entries.value.find(entry => entry.provider.id === artifact.provider_id && entry.model.model_id === artifact.model_id)
      if (matching) modelKey.value = `${matching.provider.id}:${matching.model.model_id}`
      applyArtifactDraft(artifact, route.query.mode === 'edit')
    }
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
async function poll(runId: number) {
  clearTimeout(pollTimer)
  const run = await api.artifactRun(runId)
  const index = runs.value.findIndex(item => item.id === run.id)
  if (index < 0) runs.value.unshift(run)
  else runs.value[index] = run
  if (run.status === 'queued' || run.status === 'running') pollTimer = setTimeout(() => void poll(runId), 1000)
  else {
    submitting.value = false
    await loadConversationData()
    if (run.status === 'failed') toast.error(run.error ?? '图片生成失败')
  }
}
async function submit() {
  const model = parseModel()
  if (!model || !canSubmit.value) return
  submitting.value = true
  try {
    const created = await api.createImageRun(buildImageRunInput({
      model, ...(props.conversationId === null ? {} : { conversationId: props.conversationId }), prompt: prompt.value,
      references: references.value.map(item => item.attachmentId), count: count.value, customSize: customSize.value,
      width: width.value, height: height.value, quality: quality.value, background: background.value as '' | 'transparent' | 'opaque',
      outputFormat: outputFormat.value as '' | 'png' | 'webp' | 'jpeg',
    }))
    prompt.value = ''
    releaseReferences()
    if (props.conversationId === null) await router.replace(`/images/s/${created.conversation_id}`)
    else await poll(created.run_id)
  } catch (error) { submitting.value = false; toast.error(error instanceof Error ? error.message : String(error)) }
}
async function cancel() {
  if (!latestRun.value) return
  runs.value[0] = await api.cancelArtifactRun(latestRun.value.id)
  submitting.value = false
}

watch(() => props.conversationId, () => void load())
onMounted(load)
onBeforeUnmount(() => { clearTimeout(pollTimer); releaseReferences() })
</script>

<template>
  <Teleport to="#page-header" defer>
    <span class="truncate text-sm font-medium">图片 Studio</span>
    <Button as-child variant="ghost" size="sm" class="ml-auto min-h-10 md:min-h-8"><RouterLink to="/images"><ImagesIcon data-icon="inline-start" />Gallery</RouterLink></Button>
    <Button variant="ghost" size="icon-sm" class="min-h-10 min-w-10 lg:hidden" aria-label="生成参数" @click="parametersOpen = true"><SlidersHorizontalIcon /></Button>
  </Teleport>
  <div class="grid h-full min-h-0 lg:grid-cols-[14rem_minmax(0,1fr)_18rem]">
    <aside class="hidden min-h-0 border-r lg:flex lg:flex-col">
      <div class="flex items-center gap-2 p-3"><span class="text-sm font-medium">创作历史</span><Button as-child size="icon-xs" variant="ghost" class="ml-auto"><RouterLink to="/images/new" aria-label="新建图片"><SparklesIcon /></RouterLink></Button></div>
      <ScrollArea class="min-h-0 flex-1 px-2 pb-3">
        <div class="flex flex-col gap-1">
          <Button v-for="item in conversations" :key="item.id" as-child variant="ghost" class="h-auto min-h-12 justify-start px-2 py-2 text-left">
            <RouterLink :to="`/images/s/${item.id}`"><span class="truncate">{{ item.title }}</span></RouterLink>
          </Button>
        </div>
      </ScrollArea>
    </aside>

    <main class="flex min-h-0 min-w-0 flex-col">
      <ScrollArea class="min-h-0 flex-1">
        <div class="mx-auto flex min-h-full w-full max-w-5xl items-center justify-center p-4 md:p-8">
          <div v-if="loading" class="grid w-full grid-cols-2 gap-3"><Skeleton class="aspect-square rounded-xl" /><Skeleton class="aspect-square rounded-xl" /></div>
          <div v-else-if="outputs.length" class="grid w-full gap-3" :class="outputs.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
            <RouterLink v-for="artifact in outputs" :key="artifact.id" :to="`/images/a/${artifact.id}`" class="group relative overflow-hidden rounded-xl border bg-muted">
              <img :src="api.artifactContentUrl(artifact.id)" :alt="artifact.prompt" class="h-full w-full object-contain" loading="lazy" />
              <Badge class="absolute bottom-3 left-3 opacity-0 transition-opacity group-hover:opacity-100" variant="secondary">查看详情</Badge>
            </RouterLink>
          </div>
          <Empty v-else>
            <EmptyHeader><EmptyMedia variant="icon"><ImagesIcon /></EmptyMedia><EmptyTitle>开始创作</EmptyTitle><EmptyDescription>描述你想生成的画面，也可以添加参考图进行编辑。</EmptyDescription></EmptyHeader>
          </Empty>
        </div>
      </ScrollArea>
      <div class="border-t bg-background p-3">
        <div class="mx-auto w-full max-w-3xl">
          <div v-if="references.length" class="mb-2 flex flex-wrap gap-2">
            <Card v-for="(image, index) in references" :key="image.attachmentId" class="relative overflow-hidden py-0"><CardContent class="p-0"><img :src="image.preview" alt="参考图" class="size-20 object-cover" /></CardContent><Button size="icon-xs" variant="secondary" class="absolute right-1 top-1" aria-label="移除参考图" @click="removeReference(index)"><XIcon /></Button></Card>
          </div>
          <InputGroup class="rounded-xl">
            <InputGroupTextarea v-model="prompt" rows="2" class="max-h-[35vh] text-base md:text-sm" placeholder="描述你想生成或修改的图片…" @keydown.enter.exact.prevent="submit" />
            <InputGroupAddon align="block-end">
              <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="onFiles" />
              <InputGroupButton size="icon-sm" aria-label="添加参考图" :disabled="!referenceAllowed" @click="chooseFiles"><ImagePlusIcon /></InputGroupButton>
              <span v-if="references.length && !referenceAllowed" class="text-xs text-destructive">当前模型不支持图片输入</span>
              <div class="ml-auto flex items-center gap-2">
                <Badge v-if="latestRun" variant="outline">{{ latestRun.status }}</Badge>
                <InputGroupButton v-if="running" variant="destructive" size="sm" @click="cancel"><XIcon data-icon="inline-start" />取消</InputGroupButton>
                <InputGroupButton v-else size="sm" variant="default" :disabled="!canSubmit" @click="submit"><LoaderCircleIcon v-if="submitting" class="animate-spin" data-icon="inline-start" /><SparklesIcon v-else data-icon="inline-start" />生成</InputGroupButton>
              </div>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </main>

    <aside class="hidden min-h-0 border-l p-4 lg:block"><ScrollArea class="h-full"><ImageParameters v-model:model="modelKey" v-model:count="count" v-model:custom-size="customSize" v-model:width="width" v-model:height="height" v-model:quality="quality" v-model:background="background" v-model:output-format="outputFormat" :models="modelOptions" /></ScrollArea></aside>
  </div>
  <ResponsiveOverlay v-model:open="parametersOpen" title="生成参数">
    <ImageParameters v-model:model="modelKey" v-model:count="count" v-model:custom-size="customSize" v-model:width="width" v-model:height="height" v-model:quality="quality" v-model:background="background" v-model:output-format="outputFormat" :models="modelOptions" />
  </ResponsiveOverlay>
</template>
