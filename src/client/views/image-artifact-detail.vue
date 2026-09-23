<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, ImagePlusIcon, RefreshCwIcon, TrashIcon } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { useRouteOverlay } from '@/client/composables/use-route-overlay'
import { routeParamToId } from '@/client/lib/route-params'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Separator } from '@/client/ui/separator'
import { Skeleton } from '@/client/ui/skeleton'
import type { ArtifactDto } from '@/shared/artifacts'

const props = defineProps<{ artifactId: number | null }>()
const route = useRoute()
const router = useRouter()
const artifact = ref<ArtifactDto | null>(null)
/** The other outputs of the same run, in output order — what the arrows step through. */
const siblings = ref<ArtifactDto[]>([])
const position = computed(() => (artifact.value ? siblings.value.findIndex(item => item.id === artifact.value!.id) : -1))
const previous = computed(() => (position.value > 0 ? siblings.value[position.value - 1] : undefined))
const next = computed(() => (position.value >= 0 ? siblings.value[position.value + 1] : undefined))
const { open, setOpen: close } = useRouteOverlay(() => {
  const value = (route.params as Record<string, unknown>).conversationId
  const conversationId = routeParamToId(typeof value === 'string' ? value : undefined)
  return conversationId === null ? '/images' : `/images/s/${conversationId}`
})
async function load() {
  if (props.artifactId === null) return close(false)
  const known = siblings.value.find(item => item.id === props.artifactId)
  if (known) { artifact.value = known; return }
  try { artifact.value = await api.artifact(props.artifactId) }
  catch { toast.error('图片不存在'); close(false); return }
  // Stepping is a convenience: without the list the dialog still shows this image, just no arrows.
  try {
    const page = await api.artifacts({ run_id: artifact.value.run_id, limit: 100 })
    siblings.value = page.artifacts.sort((a, b) => a.output_index - b.output_index)
  } catch { siblings.value = [] }
}
/** Replace, not push: Back should close the dialog, not walk back through every image viewed. */
function step(target: ArtifactDto | undefined) {
  if (target) void router.replace(route.path.replace(/\/\d+$/u, `/${target.id}`))
}
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (!open.value || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]')) return
  if (event.key === 'ArrowLeft') step(previous.value)
  else if (event.key === 'ArrowRight') step(next.value)
})
async function copyPrompt() {
  if (!artifact.value) return
  await navigator.clipboard.writeText(artifact.value.prompt)
  toast.success('已复制提示词')
}
async function remove() {
  if (!artifact.value) return
  await api.deleteArtifact(artifact.value.id)
  toast.success('已从 Gallery 删除')
  close(false)
}
onMounted(load)
watch(() => props.artifactId, () => void load())
</script>

<template>
  <ResponsiveOverlay :open="open" title="图片详情" mode="dialog" @update:open="close">
    <div v-if="!artifact" class="grid gap-4 md:grid-cols-2"><Skeleton class="aspect-square rounded-xl" /><Skeleton class="h-48 rounded-xl" /></div>
    <div v-else class="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
      <div class="relative overflow-hidden rounded-xl border bg-muted">
        <img :src="api.artifactContentUrl(artifact.id, 'preview')" :alt="artifact.prompt" class="h-full w-full object-contain" />
        <template v-if="siblings.length > 1">
          <span class="absolute left-2 top-2 rounded-md bg-background/80 px-2 py-0.5 text-xs tabular-nums backdrop-blur">{{ position + 1 }} / {{ siblings.length }}</span>
          <Button size="icon" variant="secondary" class="absolute left-2 top-1/2 -translate-y-1/2 rounded-full shadow-sm" aria-label="上一张" :disabled="!previous" @click="step(previous)"><ChevronLeftIcon /></Button>
          <Button size="icon" variant="secondary" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full shadow-sm" aria-label="下一张" :disabled="!next" @click="step(next)"><ChevronRightIcon /></Button>
        </template>
      </div>
      <div class="flex flex-col gap-4">
        <p class="whitespace-pre-wrap text-sm">{{ artifact.prompt }}</p>
        <Separator />
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm"><dt class="text-muted-foreground">模型</dt><dd class="truncate">{{ artifact.model_name }}</dd><dt class="text-muted-foreground">供应商</dt><dd>{{ artifact.provider_name }}</dd><dt class="text-muted-foreground">尺寸</dt><dd>{{ artifact.width && artifact.height ? `${artifact.width} × ${artifact.height}` : '供应商默认' }}</dd><dt class="text-muted-foreground">来源</dt><dd><RouterLink v-if="artifact.conversation_id" :to="`/images/s/${artifact.conversation_id}`" class="font-medium underline-offset-4 hover:underline">Conversation #{{ artifact.conversation_id }}</RouterLink><span v-else>来源已删除</span></dd></dl>
        <div class="flex flex-wrap gap-2"><Button variant="outline" size="sm" @click="copyPrompt"><CopyIcon data-icon="inline-start" />复制提示词</Button><Button as-child variant="outline" size="sm"><a :href="api.artifactContentUrl(artifact.id)" download><DownloadIcon data-icon="inline-start" />下载</a></Button><Button as-child size="sm"><RouterLink :to="`/images/new?source=${artifact.id}`"><RefreshCwIcon data-icon="inline-start" />再生成</RouterLink></Button><Button as-child size="sm"><RouterLink :to="`/images/new?source=${artifact.id}&mode=edit`"><ImagePlusIcon data-icon="inline-start" />参考图编辑</RouterLink></Button><Button variant="destructive" size="sm" @click="remove"><TrashIcon data-icon="inline-start" />删除</Button></div>
      </div>
    </div>
  </ResponsiveOverlay>
</template>
