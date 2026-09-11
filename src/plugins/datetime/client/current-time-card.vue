<script setup lang="ts">
import { computed } from 'vue'
import { ClockIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { CurrentTimeErrorSchema, CurrentTimeInputSchema, CurrentTimeOutputSchema } from '../shared'

const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()

const requested = computed(() => CurrentTimeInputSchema.safeParse(props.call.args).data?.timezone ?? 'UTC')
const output = computed(() => CurrentTimeOutputSchema.safeParse(props.result?.content).data ?? null)
const failure = computed(() => CurrentTimeErrorSchema.safeParse(props.result?.content).data?.error ?? null)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  Alert(v-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle 查询时间失败
    AlertDescription {{ failure }}
  //- One row in every state, per the convention beside .oc-turn-row.
  .oc-turn-row.text-sm.text-muted-foreground(v-else-if="!result")
    Spinner(class="size-4 shrink-0")
    span 正在查询 {{ requested }} 的时间
  .oc-turn-row.text-sm(v-else-if="output")
    ClockIcon(class="size-4 shrink-0 text-muted-foreground")
    span.min-w-0.truncate {{ output.local }}
    span.shrink-0.text-muted-foreground {{ output.timezone }}
</template>
