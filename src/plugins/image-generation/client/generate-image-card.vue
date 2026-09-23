<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ImagesIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { api } from '@/client/lib/api'
import { useAuditContext } from '@/client/lib/audit-context'
import { cn } from '@/client/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import type { ArtifactDto, ArtifactRunDto } from '@/shared/artifacts'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { GenerateImageErrorSchema, GenerateImageInputSchema, GenerateImageStartedSchema, runIdOf } from '../shared'
import { thumbnailGridClass } from './thumbnail-grid'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()
// Runs belong to the transcript's owner; an auditor's session cannot read them, so it shows the summary only.
const auditing = useAuditContext() !== null
const input = computed(() => GenerateImageInputSchema.safeParse(props.call.args).data ?? null)
const started = computed(() => GenerateImageStartedSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => GenerateImageErrorSchema.safeParse(props.result?.content).data?.error ?? null)
const runId = computed(() => (started.value ? runIdOf(started.value.task_id) : null))
const run = ref<ArtifactRunDto | null>(null)
const outputs = ref<ArtifactDto[]>([])
const cancelling = ref(false)
const pending = computed(() => !run.value || run.value.status === 'queued' || run.value.status === 'running')
const tiles = computed(() => started.value?.count ?? input.value?.count ?? 1)
let timer: ReturnType<typeof setTimeout> | undefined

async function refresh(): Promise<void> {
  const id = runId.value
  if (id === null) return
  try {
    run.value = await api.artifactRun(id)
    if (run.value.status === 'queued' || run.value.status === 'running') {
      timer = setTimeout(() => void refresh(), 1500)
      return
    }
    if (run.value.status === 'completed') {
      outputs.value = (await api.artifacts({ run_id: id })).artifacts.sort((a, b) => a.output_index - b.output_index)
    }
  } catch {
    timer = setTimeout(() => void refresh(), 3000)
  }
}

async function cancel(): Promise<void> {
  if (runId.value === null) return
  cancelling.value = true
  try { run.value = await api.cancelArtifactRun(runId.value) }
  finally { cancelling.value = false }
}

watch(runId, (id) => {
  clearTimeout(timer)
  if (id !== null && !auditing) void refresh()
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  Alert(v-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 无法生成图片
    AlertDescription {{ failure }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else-if="!result")
    Spinner(class="size-4 shrink-0")
    span 正在提交生图任务
  template(v-else-if="started")
    .oc-turn-row.text-sm
      ImagesIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate {{ input?.prompt ?? '生成图片' }}
      span.shrink-0.text-muted-foreground(v-if="auditing || run?.status === 'completed'") {{ started.count }} 张 · {{ started.model }}
      span.shrink-0.text-muted-foreground(v-else-if="run?.status === 'cancelled'") 已取消
      span.shrink-0.text-muted-foreground(v-else-if="run?.status === 'failed'") 失败
      template(v-else)
        Spinner(class="size-3.5 shrink-0 text-muted-foreground")
        Button(size="xs" variant="ghost" class="ml-auto" :disabled="cancelling" @click="cancel")
          XIcon(data-icon="inline-start")
          | 取消
    template(v-if="!auditing")
      .grid.w-full.gap-2(v-if="pending" :class="thumbnailGridClass(tiles)")
        Skeleton(v-for="index in tiles" :key="index" class="aspect-square rounded-lg")
      .grid.w-full.gap-2(v-else-if="outputs.length" :class="thumbnailGridClass(outputs.length)")
        RouterLink(
          v-for="artifact in outputs" :key="artifact.id" :to="`/images/a/${artifact.id}`"
          :class="cn('group block aspect-square overflow-hidden rounded-lg border bg-muted')" :aria-label="`查看第 ${artifact.output_index + 1} 张`")
          img.size-full.object-cover.transition-transform.duration-300(class="group-hover:scale-[1.03]" :src="api.artifactContentUrl(artifact.id, 'gallery')" :alt="artifact.prompt" loading="lazy")
      p.text-xs.text-destructive(v-else-if="run?.status === 'failed'") {{ run.error ?? '供应商未返回具体错误。' }}
</template>
