<script setup lang="ts">
import { computed } from 'vue'
import { BrainIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { basename } from '@/plugins/workspace-files/client/format'
import type { MemorySaveInput, MemorySaveOutput, MemoryToolError } from '../shared'

const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<MemorySaveInput>)
const content = computed(() => props.result?.content as MemorySaveOutput | MemoryToolError | undefined)
const output = computed(() => (content.value && 'metadata' in content.value ? content.value : null))
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const path = computed(() => output.value?.path ?? input.value.path ?? '')

const CATEGORY_LABELS: Record<string, string> = { profile: '个人档案', preferences: '回复偏好', topics: '话题', areas: '进行中', people: '人物' }

const label = computed(() => {
  const value = output.value
  if (!value) return ''
  if (value.operation === undefined) return '已更新描述'
  return value.operation === 'created' ? '已记住' : '已更新记忆'
})
const inProject = computed(() => path.value.startsWith('/memory/project/'))
const scope = computed(() => (inProject.value ? '当前项目' : '所有会话'))
/** A Project's profile describes the Project, not the user. */
const category = computed(() => {
  const value = output.value?.category
  if (value === 'profile' && inProject.value) return '项目档案'
  return value === undefined ? '' : CATEGORY_LABELS[value] ?? value
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在保存记忆 {{ basename(path) }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 记忆未保存
    AlertDescription {{ failure.message }}
  template(v-else-if="output")
    .oc-turn-row.text-sm(:title="output.path")
      BrainIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate {{ label }} {{ basename(output.path) }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ category }} · {{ scope }}
    p(class="text-muted-foreground pl-6 text-xs") {{ output.description }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span 工具结果无法解析
</template>
