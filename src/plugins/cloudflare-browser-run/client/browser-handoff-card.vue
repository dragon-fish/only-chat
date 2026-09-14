<script setup lang="ts">
import { computed } from 'vue'
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { BrowserHandoffInputSchema, BrowserHandoffResultSchema, type BrowserHandoffResult } from '../shared'

const props = defineProps<{
  call: ToolCallPart
  result: ToolResultPart | null
  canContinue: boolean
  busy?: boolean
}>()
const emit = defineEmits<{ respond: [result: BrowserHandoffResult]; continue: [] }>()

const instructions = computed(() => BrowserHandoffInputSchema.safeParse(props.call.args).data?.instructions ?? '（说明无法解析）')
const outcome = computed(() => BrowserHandoffResultSchema.safeParse(props.result?.content).data ?? null)
</script>

<template lang="pug">
Alert(v-if="outcome?.status === 'done'")
  CircleCheckIcon
  AlertTitle 你已完成接管
  AlertDescription.whitespace-pre-wrap {{ instructions }}
Alert(v-else-if="outcome?.status === 'failed'")
  CircleXIcon
  AlertTitle 接管未完成
  AlertDescription.whitespace-pre-wrap {{ instructions }}
Alert(v-else-if="outcome?.status === 'skipped'")
  CircleXIcon
  AlertTitle 你跳过了这次接管
  AlertDescription.whitespace-pre-wrap {{ instructions }}
Alert(v-else class="border-primary")
  CircleHelpIcon
  AlertTitle 模型请你在浏览器里接手
  AlertDescription
    p.whitespace-pre-wrap {{ instructions }}
    p.mt-1.text-xs.text-muted-foreground 在右侧工作区的浏览器页签里操作，做完回来点一下。
    .mt-2.flex.gap-2
      Button(size="sm" class="min-h-9" :disabled="busy" @click="emit('respond', { status: 'done' })") 完成
      Button(size="sm" variant="outline" class="min-h-9" :disabled="busy" @click="emit('respond', { status: 'failed' })") 失败
</template>
