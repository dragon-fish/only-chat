<script setup lang="ts">
import { computed } from 'vue'
import { modelBadges, modelName, type EnabledModelEntry } from '@/client/lib/ui-models'
import { Badge } from '@/client/ui/badge'
import { Separator } from '@/client/ui/separator'
const props = defineProps<{ entry: EnabledModelEntry }>()
const metadata = computed(() => props.entry.model.metadata)
const reasoning = computed(() => metadata.value.reasoning_options?.flatMap(option => {
  if (option.type === 'effort') return option.values.filter((value): value is NonNullable<typeof value> => value !== null)
  if (option.type === 'toggle') return ['可开关']
  return [`Token 预算 ${option.min ?? '不限'}–${option.max ?? '不限'}`]
}).join('、'))
const number = (value: number | undefined) => value === undefined ? '未声明' : value.toLocaleString()
</script>

<template>
  <div data-model-details class="flex min-w-0 flex-col gap-3">
    <p class="break-words font-medium">{{ modelName(entry.model) }}</p>
    <Separator />
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      <dt class="text-muted-foreground">供应商</dt><dd class="break-words text-right">{{ entry.provider.name }}</dd>
      <dt class="text-muted-foreground">模型 ID</dt><dd class="break-all text-right font-mono">{{ entry.model.model_id }}</dd>
    </dl>
    <div v-if="modelBadges(entry.model).length" class="flex flex-wrap gap-1">
      <Badge v-for="badge in modelBadges(entry.model)" :key="badge.key" variant="secondary">{{ badge.label }}</Badge>
    </div>
    <Separator />
    <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
      <dt class="text-muted-foreground">上下文窗口</dt><dd class="text-right tabular-nums">{{ number(metadata.limit?.context) }}</dd>
      <dt class="text-muted-foreground">最大输出</dt><dd class="text-right tabular-nums">{{ number(metadata.limit?.output) }}</dd>
      <template v-if="reasoning"><dt class="text-muted-foreground">推理选项</dt><dd class="break-words text-right">{{ reasoning }}</dd></template>
    </dl>
    <p v-if="entry.model.upstream_available === false" class="text-xs text-muted-foreground">供应商已不再提供此模型</p>
  </div>
</template>
