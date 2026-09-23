<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, DownloadIcon, ImagePlusIcon, InfoIcon, RefreshCwIcon, TrashIcon, XIcon } from '@lucide/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useRouteOverlay } from '@/client/composables/use-route-overlay'
import { routeParamToId } from '@/client/lib/route-params'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/client/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import { Separator } from '@/client/ui/separator'
import { Skeleton } from '@/client/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
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
/** The viewer is dark in both themes, so its controls cannot use the theme's ghost colours. */
const toolClass = 'rounded-full text-white/85 hover:bg-white/15 hover:text-white disabled:text-white/30'

async function load() {
  if (props.artifactId === null) return close(false)
  const known = siblings.value.find(item => item.id === props.artifactId)
  if (known) { artifact.value = known; return }
  try { artifact.value = await api.artifact(props.artifactId) }
  catch { toast.error('图片不存在'); close(false); return }
  // Stepping is a convenience: without the list the viewer still shows this image, just no arrows.
  try {
    const page = await api.artifacts({ run_id: artifact.value.run_id, limit: 100 })
    siblings.value = page.artifacts.sort((a, b) => a.output_index - b.output_index)
  } catch { siblings.value = [] }
}
/** Replace, not push: Back should close the viewer, not walk back through every image viewed. */
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
  <Dialog :open="open" @update:open="close">
    <DialogContent
      :show-close-button="false" :aria-describedby="undefined"
      class="left-0 top-0 flex h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none bg-black/95 p-0 text-white ring-0 sm:max-w-none"
    >
      <DialogTitle class="sr-only">图片详情</DialogTitle>
      <Button size="icon" variant="ghost" :class="[toolClass, 'absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10']" aria-label="关闭" @click="close(false)"><XIcon /></Button>

      <!-- The stage leaves room under the toolbar so it never covers the image; a click on the empty
           stage around the image closes, like any lightbox. -->
      <div class="flex min-h-0 flex-1 items-center justify-center px-4 pb-24 pt-16 md:px-16" @click.self="close(false)">
        <Skeleton v-if="!artifact" class="aspect-square h-[min(60vh,32rem)] rounded-xl bg-white/10" />
        <img v-else :src="api.artifactContentUrl(artifact.id)" :alt="artifact.prompt" class="max-h-full max-w-full rounded-md object-contain" />
      </div>

      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div v-if="artifact" class="pointer-events-auto flex items-center gap-1 rounded-full bg-neutral-900/85 p-1.5 shadow-lg ring-1 ring-white/10 backdrop-blur">
          <template v-if="siblings.length > 1">
            <Button size="icon" variant="ghost" :class="toolClass" aria-label="上一张" :disabled="!previous" @click="step(previous)"><ChevronLeftIcon /></Button>
            <span class="min-w-12 text-center text-xs tabular-nums text-white/70">{{ position + 1 }} / {{ siblings.length }}</span>
            <Button size="icon" variant="ghost" :class="toolClass" aria-label="下一张" :disabled="!next" @click="step(next)"><ChevronRightIcon /></Button>
            <Separator orientation="vertical" class="mx-1 h-5 bg-white/15" />
          </template>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button as-child size="icon" variant="ghost" :class="toolClass"><RouterLink :to="`/images/new?source=${artifact.id}&mode=edit`" aria-label="参考图编辑"><ImagePlusIcon /></RouterLink></Button>
            </TooltipTrigger>
            <TooltipContent>参考图编辑</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button as-child size="icon" variant="ghost" :class="toolClass"><RouterLink :to="`/images/new?source=${artifact.id}`" aria-label="再生成"><RefreshCwIcon /></RouterLink></Button>
            </TooltipTrigger>
            <TooltipContent>再生成</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button as-child size="icon" variant="ghost" :class="toolClass"><a :href="api.artifactContentUrl(artifact.id)" download aria-label="下载原图"><DownloadIcon /></a></Button>
            </TooltipTrigger>
            <TooltipContent>下载原图</TooltipContent>
          </Tooltip>
          <!-- No tooltip here: Tooltip brings its own Popper context, which would steal the Popover's anchor. -->
          <Popover>
            <PopoverTrigger as-child>
              <Button size="icon" variant="ghost" :class="toolClass" aria-label="图片信息"><InfoIcon /></Button>
            </PopoverTrigger>
            <PopoverContent side="top" :side-offset="12" class="w-80">
              <div class="flex items-start gap-2">
                <p class="oc-scroll max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap">{{ artifact.prompt }}</p>
                <Button size="icon-sm" variant="ghost" aria-label="复制提示词" @click="copyPrompt"><CopyIcon /></Button>
              </div>
              <Separator />
              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                <dt class="text-muted-foreground">模型</dt><dd class="truncate">{{ artifact.model_name }}</dd>
                <dt class="text-muted-foreground">供应商</dt><dd class="truncate">{{ artifact.provider_name }}</dd>
                <dt class="text-muted-foreground">尺寸</dt><dd>{{ artifact.width && artifact.height ? `${artifact.width} × ${artifact.height}` : '供应商默认' }}</dd>
                <dt class="text-muted-foreground">来源</dt>
                <dd><RouterLink v-if="artifact.conversation_id" :to="`/images/s/${artifact.conversation_id}`" class="font-medium underline-offset-4 hover:underline">Conversation #{{ artifact.conversation_id }}</RouterLink><span v-else>来源已删除</span></dd>
              </dl>
            </PopoverContent>
          </Popover>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button size="icon" variant="ghost" class="rounded-full text-red-400 hover:bg-red-500/20 hover:text-red-300" aria-label="删除" @click="remove"><TrashIcon /></Button>
            </TooltipTrigger>
            <TooltipContent>删除</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
