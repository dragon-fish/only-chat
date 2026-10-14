<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ChevronRightIcon, TerminalIcon, TriangleAlertIcon } from '@lucide/vue'
import { useSyncStore } from '@/client/stores/sync'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { SandboxExecInput, SandboxExecResult, SandboxJobStartedResult, SandboxToolError } from '../shared'
import { argvToCommandLine } from './command-line'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()
const sync = useSyncStore()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<SandboxExecInput>)
const content = computed(() => props.result?.content as SandboxExecResult | SandboxJobStartedResult | SandboxToolError | undefined)
const finished = computed(() => (content.value && 'exit_code' in content.value ? content.value : null))
const started = computed(() => (content.value && 'task_id' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const unreadable = computed(() => props.result !== null && !finished.value && !started.value && !failure.value)

const commandLine = computed(() => input.value.command ?? (input.value.argv ? argvToCommandLine(input.value.argv) : ''))
const stdinBytes = computed(() => (input.value.stdin === undefined ? null : new TextEncoder().encode(input.value.stdin).length))
const meta = computed(() => {
  const parts: string[] = []
  if (input.value.cwd) parts.push(input.value.cwd)
  if (finished.value) parts.push(`${(finished.value.duration_ms / 1000).toFixed(1)} s`)
  if (stdinBytes.value !== null) parts.push(`stdin：${stdinBytes.value} 字节`)
  return parts.join(' · ')
})
const notes = computed(() => finished.value?.notes ?? started.value?.notes ?? [])

/** While the call runs, the live lines; afterwards the result is the record. */
const liveLines = computed(() => sync.toolProgress.get(props.call.id) ?? [])
const liveBox = ref<HTMLElement | null>(null)
watch(() => liveLines.value.length, async () => {
  await nextTick()
  if (liveBox.value) liveBox.value.scrollTop = liveBox.value.scrollHeight
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  Alert(v-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 命令未执行
    AlertDescription.whitespace-pre-wrap {{ failure.error }}
  Collapsible(v-else-if="!unreadable" :default-open="!result")
    CollapsibleTrigger(class="oc-turn-row group text-sm hover:bg-accent")
      TerminalIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.flex-1.truncate.text-left.font-mono.text-xs(:title="commandLine") {{ commandLine }}
      Spinner(v-if="!result" class="size-4 shrink-0")
      Badge(v-else-if="started" variant="secondary" class="shrink-0") 后台运行
      Badge(v-else-if="finished?.timed_out" variant="destructive" class="shrink-0") 超时
      Badge(v-else-if="finished?.exit_code === 0" variant="secondary" class="shrink-0 text-green-700" ) 退出 0
      Badge(v-else-if="finished" variant="destructive" class="shrink-0") 退出 {{ finished.exit_code }}
      ChevronRightIcon(class="ml-1 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
    p.px-3.text-xs.text-muted-foreground(v-if="meta") {{ meta }}
    CollapsibleContent.flex.flex-col.gap-2(class="mt-2")
      template(v-if="!result")
        pre.oc-scroll.max-h-80.overflow-auto.whitespace-pre-wrap.rounded-md.bg-muted.px-3.py-2.text-xs(v-if="liveLines.length" ref="liveBox") {{ liveLines.join('\\n') }}
        p.text-xs.text-muted-foreground(v-else) 等待输出…
      template(v-else-if="finished")
        template(v-if="finished.stdout")
          p.text-xs.text-muted-foreground stdout
          pre.oc-scroll.max-h-80.overflow-auto.whitespace-pre-wrap.rounded-md.bg-muted.px-3.py-2.text-xs {{ finished.stdout }}
        template(v-if="finished.stderr")
          p.text-xs.text-muted-foreground stderr
          pre.oc-scroll.max-h-80.overflow-auto.whitespace-pre-wrap.rounded-md.bg-muted.px-3.py-2.text-xs {{ finished.stderr }}
        p.text-xs.text-muted-foreground(v-if="!finished.stdout && !finished.stderr") 无输出
        p.text-xs.text-muted-foreground(v-if="finished.truncated") 输出已截断，完整内容在 {{ finished.log_path }}
      template(v-else-if="started")
        p.text-xs.text-muted-foreground 任务 {{ started.task_id }} · pid {{ started.pid }}
        p.text-xs.text-muted-foreground 日志：{{ started.log_path }}
        p.text-xs.text-muted-foreground 结束后会以通知的形式告知结果。
      p.text-xs.text-muted-foreground(v-for="note in notes" :key="note") {{ note }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
