<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { CopyIcon, DownloadIcon, ImagePlusIcon, RefreshCwIcon, TrashIcon } from '@lucide/vue'
import { useRoute } from 'vue-router'
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
const artifact = ref<ArtifactDto | null>(null)
const { open, setOpen: close } = useRouteOverlay(() => {
  const value = (route.params as Record<string, unknown>).conversationId
  const conversationId = routeParamToId(typeof value === 'string' ? value : undefined)
  return conversationId === null ? '/images' : `/images/s/${conversationId}`
})
async function load() {
  if (props.artifactId === null) return close(false)
  try { artifact.value = await api.artifact(props.artifactId) }
  catch { toast.error('图片不存在'); close(false) }
}
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
</script>

<template>
  <ResponsiveOverlay :open="open" title="图片详情" mode="dialog" @update:open="close">
    <div v-if="!artifact" class="grid gap-4 md:grid-cols-2"><Skeleton class="aspect-square rounded-xl" /><Skeleton class="h-48 rounded-xl" /></div>
    <div v-else class="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
      <div class="overflow-hidden rounded-xl border bg-muted"><img :src="api.artifactContentUrl(artifact.id, 'preview')" :alt="artifact.prompt" class="h-full w-full object-contain" /></div>
      <div class="flex flex-col gap-4">
        <p class="whitespace-pre-wrap text-sm">{{ artifact.prompt }}</p>
        <Separator />
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm"><dt class="text-muted-foreground">模型</dt><dd class="truncate">{{ artifact.model_name }}</dd><dt class="text-muted-foreground">供应商</dt><dd>{{ artifact.provider_name }}</dd><dt class="text-muted-foreground">尺寸</dt><dd>{{ artifact.width && artifact.height ? `${artifact.width} × ${artifact.height}` : '供应商默认' }}</dd><dt class="text-muted-foreground">来源</dt><dd><RouterLink v-if="artifact.conversation_id" :to="`/images/s/${artifact.conversation_id}`" class="font-medium underline-offset-4 hover:underline">Conversation #{{ artifact.conversation_id }}</RouterLink><span v-else>来源已删除</span></dd></dl>
        <div class="flex flex-wrap gap-2"><Button variant="outline" size="sm" @click="copyPrompt"><CopyIcon data-icon="inline-start" />复制提示词</Button><Button as-child variant="outline" size="sm"><a :href="api.artifactContentUrl(artifact.id)" download><DownloadIcon data-icon="inline-start" />下载</a></Button><Button as-child size="sm"><RouterLink :to="`/images/new?source=${artifact.id}`"><RefreshCwIcon data-icon="inline-start" />再生成</RouterLink></Button><Button as-child size="sm"><RouterLink :to="`/images/new?source=${artifact.id}&mode=edit`"><ImagePlusIcon data-icon="inline-start" />参考图编辑</RouterLink></Button><Button variant="destructive" size="sm" @click="remove"><TrashIcon data-icon="inline-start" />删除</Button></div>
      </div>
    </div>
  </ResponsiveOverlay>
</template>
