<script setup lang="ts">
import { computed } from 'vue'
import { ImagesIcon, TriangleAlertIcon, XIcon } from '@lucide/vue'
import { RouterLink, useRoute } from 'vue-router'
import { withViewer } from '@/client/lib/image-viewer'
import { api } from '@/client/lib/api'
import { useArtifactRun } from '@/client/lib/artifact-run'
import { useAuditContext } from '@/client/lib/audit-context'
import { thumbnailGridClass } from '@/client/lib/thumbnail-grid'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Skeleton } from '@/client/ui/skeleton'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { runIdOf } from '@/shared/artifacts'
import { ComfyuiGenerateStartedSchema, ComfyuiToolErrorSchema } from '../shared'
import { nodeErrorLines } from './node-errors'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()
// Runs belong to the transcript's owner; an auditor's session cannot read them, so it shows the summary only.
const auditing = useAuditContext() !== null
const route = useRoute()
// Read loosely: the card must still label a call whose arguments failed validation.
const args = computed(() => (props.call.args ?? {}) as { template?: unknown, prompt?: unknown })
const label = computed(() => typeof args.value.template === 'string' ? args.value.template : 'API 工作流')
const prompt = computed(() => typeof args.value.prompt === 'string' ? args.value.prompt : null)
const started = computed(() => ComfyuiGenerateStartedSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => ComfyuiToolErrorSchema.safeParse(props.result?.content).data ?? null)
const failureLines = computed(() => nodeErrorLines(failure.value?.node_errors))
const runId = computed(() => (started.value ? runIdOf(started.value.task_id) : null))
const { run, outputs, cancelling, cancel } = useArtifactRun(runId, !auditing)
const pending = computed(() => !run.value || run.value.status === 'queued' || run.value.status === 'running')
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  Alert(v-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle {{ failure.error_type === 'validation' ? 'ComfyUI 未接受工作流' : '无法提交到 ComfyUI' }}
    AlertDescription
      p {{ failure.error }}
      ul.mt-1.list-disc.pl-4.text-xs(v-if="failureLines.length")
        li(v-for="line in failureLines" :key="line") {{ line }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else-if="!result")
    Spinner(class="size-4 shrink-0")
    span 正在提交到 ComfyUI
  template(v-else-if="started")
    .oc-turn-row.text-sm
      ImagesIcon(class="size-4 shrink-0 text-muted-foreground")
      span.shrink-0 ComfyUI 出图
      Badge(variant="secondary" class="shrink-0") {{ label }}
      span.min-w-0.truncate(v-if="prompt") {{ prompt }}
      span.shrink-0.text-muted-foreground(v-if="started.seed !== undefined") seed {{ started.seed }}
      span.shrink-0.text-muted-foreground(v-if="run?.status === 'cancelled'") 已取消
      span.shrink-0.text-muted-foreground(v-else-if="run?.status === 'failed'") 失败
      template(v-else-if="!auditing && pending")
        Spinner(class="size-3.5 shrink-0 text-muted-foreground")
        Button(size="xs" variant="ghost" class="ml-auto" :disabled="cancelling" @click="cancel")
          XIcon(data-icon="inline-start")
          | 取消
    template(v-if="!auditing")
      .grid.w-full.gap-2(v-if="pending" :class="thumbnailGridClass(1)")
        Skeleton(class="aspect-square rounded-lg")
      .grid.w-full.gap-2(v-else-if="outputs.length" :class="thumbnailGridClass(outputs.length)")
        RouterLink(
          v-for="artifact in outputs" :key="artifact.id" :to="withViewer(route, artifact.id)"
          class="group block aspect-square overflow-hidden rounded-lg border bg-muted" :aria-label="`查看第 ${artifact.output_index + 1} 张`")
          img.size-full.object-cover.transition-transform.duration-300(class="group-hover:scale-[1.03]" :src="api.artifactContentUrl(artifact.id, 'gallery')" :alt="artifact.prompt" loading="lazy")
      p.text-xs.text-destructive(v-else-if="run?.status === 'failed'") {{ run.error ?? 'ComfyUI 未返回具体错误。' }}
</template>
