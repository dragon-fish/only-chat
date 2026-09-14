<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ClockIcon, ImagePlusIcon, ImagesIcon, LoaderCircleIcon, RotateCcwIcon, SlidersHorizontalIcon, SparklesIcon, XIcon } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { toast } from 'vue-sonner'
import ImageParameters from '@/client/components/image-parameters.vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { api } from '@/client/lib/api'
import { buildImageRunInput, isStudioImageModel } from '@/client/lib/image-studio'
import { uploadImage } from '@/client/lib/image-prep'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Badge } from '@/client/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent } from '@/client/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/client/ui/empty'
import { Field, FieldDescription, FieldLabel } from '@/client/ui/field'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/client/ui/input-group'
import { ScrollArea } from '@/client/ui/scroll-area'
import { Separator } from '@/client/ui/separator'
import { Skeleton } from '@/client/ui/skeleton'
import type { ArtifactDto, ArtifactRunDto, ImageGenerationParams } from '@/shared/artifacts'
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
const chronologicalRuns = computed(() => [...runs.value].reverse())
const running = computed(() => latestRun.value && ['queued', 'running'].includes(latestRun.value.status))
const statusLabel = computed(() => ({
  queued: '等待中', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消',
}[latestRun.value?.status ?? 'completed']))
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
function addArtifactReference(artifact: ArtifactDto) {
  if (!referenceAllowed.value || references.value.some(image => image.attachmentId === artifact.attachment_id)) return
  references.value.push({ attachmentId: artifact.attachment_id, preview: api.artifactContentUrl(artifact.id, 'gallery') })
}
function outputsFor(runId: number) {
  return outputs.value.filter(artifact => artifact.run_id === runId)
}
function applyParams(params: ImageGenerationParams) {
  count.value = params.count
  customSize.value = params.size !== null
  width.value = params.size?.width ?? 1024
  height.value = params.size?.height ?? 1024
  quality.value = params.quality ?? ''
  background.value = params.background ?? ''
  outputFormat.value = params.output_format ?? ''
}
function restoreRun(run: ArtifactRunDto) {
  releaseReferences()
  prompt.value = run.prompt
  modelKey.value = run.provider_id === null ? modelKey.value : `${run.provider_id}:${run.model_id}`
  applyParams(run.params)
  references.value = (run.reference_attachment_ids ?? []).map(attachmentId => ({
    attachmentId,
    preview: api.attachmentUrl(attachmentId),
  }))
}
function formatDuration(run: ArtifactRunDto): string | null {
  if (run.started_at === null || run.completed_at === null) return null
  const seconds = Math.max(0, run.completed_at - run.started_at) / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}
function runDividerLabel(run: ArtifactRunDto): string {
  if (run.status === 'queued' || run.status === 'running') return '正在创建图片'
  if (run.status === 'failed') return '图片创建失败'
  if (run.status === 'cancelled') return '已取消创建'
  return '已创建图片'
}
async function retryRun(run: ArtifactRunDto) {
  if (running.value || run.provider_id === null || props.conversationId === null) return
  submitting.value = true
  try {
    const created = await api.createImageRun({
      client_request_id: crypto.randomUUID(), conversation_id: props.conversationId,
      model: { provider_id: run.provider_id, model_id: run.model_id }, prompt: run.prompt,
      reference_attachment_ids: run.reference_attachment_ids ?? [], params: run.params,
    })
    await loadConversationData()
    void poll(created.run_id)
  } catch (error) {
    submitting.value = false
    toast.error(error instanceof Error ? error.message : String(error))
  }
}
function applyArtifactDraft(artifact: ArtifactDto, edit: boolean) {
  prompt.value = artifact.prompt
  if (artifact.provider_id !== null) modelKey.value = `${artifact.provider_id}:${artifact.model_id}`
  applyParams(artifact.params)
  if (edit) references.value.push({ attachmentId: artifact.attachment_id, preview: api.artifactContentUrl(artifact.id) })
}
async function loadModels() {
  if (!config.loaded) await config.load()
  await config.loadEnabledModelList()
  if (!modelKey.value) {
    const current = props.conversationId === null ? undefined : conversations.value.find(item => item.id === props.conversationId)
    const preferred = current?.image_provider_id && current.image_model_id
      ? { provider_id: current.image_provider_id, model_id: current.image_model_id }
      : sync.settings.service_models?.image ?? undefined
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
    else if (latestRun.value?.status === 'failed' && !prompt.value.trim() && references.value.length === 0) restoreRun(latestRun.value)
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
  try {
    const run = await api.artifactRun(runId)
    const index = runs.value.findIndex(item => item.id === run.id)
    if (index < 0) runs.value.unshift(run)
    else runs.value[index] = run
    if (run.status === 'queued' || run.status === 'running') pollTimer = setTimeout(() => void poll(runId), 1000)
    else {
      submitting.value = false
      await loadConversationData()
      if (run.status === 'failed') {
        if (!prompt.value.trim() && references.value.length === 0) restoreRun(run)
        toast.error(run.error ?? '图片生成失败')
      }
    }
  } catch {
    pollTimer = setTimeout(() => void poll(runId), 2000)
  }
}
async function submit() {
  const model = parseModel()
  if (!model || !canSubmit.value) return
  // Kept, and the box goes read-only instead. Emptying it on the press would be right if something
  // took its place — the runs list only gains a row once the server answers, so the prompt would
  // simply vanish, which reads as lost rather than sent. Read-only rather than disabled: disabling
  // a focused field blurs it, and the caret does not come back.
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
    <!-- The way out on a phone. Gallery on the right happens to go back, but nothing says so, and
         every other screen puts the arrow here. -->
    <PageBackButton to="/images" label="返回图库" />
    <span class="truncate text-sm font-medium">图片 Studio</span>
    <Button as-child variant="ghost" size="sm" class="ml-auto min-h-10 md:min-h-8"><RouterLink to="/images"><ImagesIcon data-icon="inline-start" />Gallery</RouterLink></Button>
    <Button variant="ghost" size="icon-sm" class="min-h-10 min-w-10 lg:hidden" aria-label="生成参数" @click="parametersOpen = true"><SlidersHorizontalIcon /></Button>
  </Teleport>
  <div class="grid h-full min-h-0 lg:grid-cols-[minmax(0,1fr)_18rem]">
    <main class="flex min-h-0 min-w-0 flex-col">
      <ScrollArea class="min-h-0 flex-1">
        <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col p-4 md:p-8">
          <div v-if="loading" class="grid w-full grid-cols-2 gap-3"><Skeleton class="aspect-square rounded-xl" /><Skeleton class="aspect-square rounded-xl" /></div>
          <div v-else-if="chronologicalRuns.length" class="flex flex-col gap-8">
            <article v-for="run in chronologicalRuns" :key="run.id" class="flex flex-col gap-4">
              <div class="flex justify-end">
                <div class="flex max-w-[85%] flex-col gap-2 rounded-2xl rounded-br-sm bg-muted px-4 py-3">
                  <div v-if="run.reference_attachment_ids?.length" class="flex flex-wrap justify-end gap-2">
                    <img v-for="attachmentId in run.reference_attachment_ids" :key="attachmentId" :src="api.attachmentUrl(attachmentId)" alt="本轮参考图" class="size-16 rounded-lg border object-cover" loading="lazy" />
                  </div>
                  <p class="whitespace-pre-wrap text-sm">{{ run.prompt }}</p>
                </div>
              </div>

              <div class="flex justify-start">
                <div class="flex w-full max-w-4xl flex-col gap-3">
                  <div v-if="run.status === 'queued' || run.status === 'running'" class="flex flex-col gap-3">
                    <Skeleton class="aspect-square w-full max-w-2xl rounded-xl" />
                    <span class="text-sm text-muted-foreground">{{ run.status === 'queued' ? '等待生成…' : '正在生成图片，可以安全离开此页面。' }}</span>
                  </div>
                  <Alert v-else-if="run.status === 'failed'" variant="destructive">
                    <AlertTitle>图片生成失败</AlertTitle>
                    <AlertDescription>{{ run.error ?? '供应商未返回具体错误。' }}</AlertDescription>
                  </Alert>
                  <Alert v-else-if="run.status === 'cancelled'">
                    <AlertTitle>已取消生成</AlertTitle>
                    <AlertDescription>这次请求没有产生图片。</AlertDescription>
                  </Alert>
                  <div v-else class="grid w-full gap-3" :class="outputsFor(run.id).length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
                    <div v-for="artifact in outputsFor(run.id)" :key="artifact.id" class="group relative overflow-hidden rounded-xl border bg-muted">
                      <RouterLink :to="`/images/s/${props.conversationId}/a/${artifact.id}`" class="block h-full">
                        <img :src="api.artifactContentUrl(artifact.id)" :alt="artifact.prompt" class="h-full w-full object-contain" loading="lazy" />
                        <Badge class="absolute bottom-3 left-3 opacity-0 transition-opacity group-hover:opacity-100" variant="secondary">查看详情</Badge>
                      </RouterLink>
                      <Button v-if="referenceAllowed" size="sm" variant="secondary" class="absolute bottom-3 right-3 opacity-100 shadow-sm transition-opacity md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100" @click="addArtifactReference(artifact)"><ImagePlusIcon data-icon="inline-start" />继续编辑</Button>
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span v-if="formatDuration(run)" class="inline-flex items-center gap-1"><ClockIcon class="size-3.5" />{{ formatDuration(run) }}</span>
                    <span v-if="run.usage?.total_tokens">{{ run.usage.total_tokens.toLocaleString() }} tokens</span>
                    <span v-if="run.usage?.generated_images">{{ run.usage.generated_images }} 张图片</span>
                    <div class="ml-auto flex gap-2">
                      <Button v-if="run.status === 'failed'" size="xs" variant="ghost" @click="restoreRun(run)">恢复输入</Button>
                      <Button v-if="run.status !== 'queued' && run.status !== 'running'" size="xs" variant="ghost" :disabled="Boolean(running)" @click="retryRun(run)"><RotateCcwIcon data-icon="inline-start" />重试</Button>
                    </div>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-3 text-xs text-muted-foreground">
                <Separator class="flex-1" />
                <span>{{ runDividerLabel(run) }}</span>
                <Separator class="flex-1" />
              </div>
            </article>
          </div>
          <Empty v-else class="my-auto">
            <EmptyHeader><EmptyMedia variant="icon"><ImagesIcon /></EmptyMedia><EmptyTitle>开始创作</EmptyTitle><EmptyDescription>描述你想生成的画面，也可以添加参考图进行编辑。</EmptyDescription></EmptyHeader>
          </Empty>
        </div>
      </ScrollArea>
      <div class="border-t bg-background p-3">
        <div class="mx-auto w-full max-w-3xl">
          <div v-if="references.length" class="mb-2 flex flex-wrap gap-2 lg:hidden">
            <Card v-for="(image, index) in references" :key="image.attachmentId" class="relative overflow-hidden py-0"><CardContent class="p-0"><img :src="image.preview" alt="参考图" class="size-20 object-cover" /></CardContent><Button size="icon-xs" variant="secondary" class="absolute right-1 top-1" aria-label="移除参考图" @click="removeReference(index)"><XIcon /></Button></Card>
          </div>
          <InputGroup class="rounded-xl">
            <InputGroupTextarea v-model="prompt" rows="2" :readonly="submitting" class="max-h-[35vh] text-base md:text-sm" placeholder="描述你想生成或修改的图片…" @keydown.enter.exact.prevent="submit" />
            <InputGroupAddon align="block-end">
              <input ref="fileInput" type="file" accept="image/*" multiple class="hidden" @change="onFiles" />
              <InputGroupButton size="icon-sm" class="lg:hidden" aria-label="添加参考图" :disabled="!referenceAllowed" @click="chooseFiles"><ImagePlusIcon /></InputGroupButton>
              <span v-if="references.length && !referenceAllowed" class="text-xs text-destructive">当前模型不支持图片输入</span>
              <div class="ml-auto flex items-center gap-2">
                <Badge v-if="latestRun" variant="outline">{{ statusLabel }}</Badge>
                <InputGroupButton v-if="running" variant="destructive" size="sm" @click="cancel"><XIcon data-icon="inline-start" />取消</InputGroupButton>
                <InputGroupButton v-else size="sm" variant="default" :disabled="!canSubmit" @click="submit"><LoaderCircleIcon v-if="submitting" class="animate-spin" data-icon="inline-start" /><SparklesIcon v-else data-icon="inline-start" />生成</InputGroupButton>
              </div>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>
    </main>

    <aside class="hidden min-h-0 border-l p-4 lg:block">
      <ScrollArea class="h-full">
        <div class="flex flex-col gap-5">
          <Field v-if="referenceAllowed">
            <FieldLabel>参考图</FieldLabel>
            <div v-if="references.length" class="grid grid-cols-2 gap-2">
              <Card v-for="(image, index) in references" :key="image.attachmentId" class="relative overflow-hidden py-0">
                <CardContent class="p-0"><img :src="image.preview" alt="参考图" class="aspect-square w-full object-cover" /></CardContent>
                <Button size="icon-xs" variant="secondary" class="absolute right-1 top-1" aria-label="移除参考图" @click="removeReference(index)"><XIcon /></Button>
              </Card>
            </div>
            <Button type="button" variant="outline" class="min-h-10 border-dashed" @click="chooseFiles"><ImagePlusIcon data-icon="inline-start" />{{ references.length ? '添加更多参考图' : '添加参考图' }}</Button>
            <FieldDescription>有参考图时会使用图片编辑模式。</FieldDescription>
          </Field>
          <ImageParameters v-model:model="modelKey" v-model:count="count" v-model:custom-size="customSize" v-model:width="width" v-model:height="height" v-model:quality="quality" v-model:background="background" v-model:output-format="outputFormat" :models="modelOptions" />
        </div>
      </ScrollArea>
    </aside>
  </div>
  <ResponsiveOverlay v-model:open="parametersOpen" title="生成参数">
    <ImageParameters v-model:model="modelKey" v-model:count="count" v-model:custom-size="customSize" v-model:width="width" v-model:height="height" v-model:quality="quality" v-model:background="background" v-model:output-format="outputFormat" :models="modelOptions" />
  </ResponsiveOverlay>
</template>
