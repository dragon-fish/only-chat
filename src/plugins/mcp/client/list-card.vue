<script setup lang="ts">
import { computed } from 'vue'
import { ListIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import type { McpListServicesOutput, McpListToolsInput, McpListToolsOutput, McpToolError } from '../shared'
import { useMcpServerNames } from './server-names'

/** Serves both listing tools: which one it is shows in the result's shape. */
const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()
const names = useMcpServerNames()

const input = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Partial<McpListToolsInput>)
const content = computed(() => props.result?.content as McpListServicesOutput | McpListToolsOutput | McpToolError | undefined)
const failure = computed(() => (content.value && 'error' in content.value ? content.value : null))
const services = computed(() => (content.value && 'services' in content.value ? content.value : null))
const tools = computed(() => (content.value && 'tools' in content.value ? content.value : null))

const requested = computed(() => input.value.tool_names?.split(',').map(name => name.trim()).filter(Boolean) ?? [])
const title = computed(() => {
  if (!input.value.service_id) return '列出 MCP 服务'
  const name = tools.value?.name ?? names.value[input.value.service_id] ?? input.value.service_id
  return requested.value.length ? `读取 ${name} 的工具定义` : `查看 ${name} 的工具目录`
})
const missing = computed(() => (tools.value && 'missing' in tools.value ? tools.value.missing ?? [] : []))
const badge = computed(() => {
  if (services.value) return `${services.value.services.length} 个服务`
  if (tools.value) return requested.value.length ? `${tools.value.tools.length} 个定义` : `${tools.value.tools.length} 个工具`
  return ''
})
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在{{ title }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle {{ title }}失败
    AlertDescription {{ failure.message }}
  Collapsible(v-else-if="services || tools")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent")
      ListIcon(class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left {{ title }}
      Badge(variant="secondary" class="ml-auto shrink-0") {{ badge }}
    CollapsibleContent
      ul.flex.flex-col.gap-1.px-2.py-2.text-sm(v-if="services")
        li.text-muted-foreground(v-if="services.services.length === 0") {{ services.message ?? '没有启用的服务。' }}
        li(v-for="service in services.services" :key="service.service_id")
          span.font-medium {{ service.name }}
          span.ml-2.text-xs.text-destructive(v-if="service.error") {{ service.error }}
          span.ml-2.text-xs.text-muted-foreground(v-else) {{ service.tool_count }} 个工具
      ul.flex.flex-col.gap-1.px-2.py-2.text-sm(v-else-if="tools")
        li.text-muted-foreground(v-if="tools.tools.length === 0 && !missing.length") 这个服务没有可用的工具。
        li(v-for="tool in tools.tools" :key="tool.name")
          span.font-mono {{ tool.name }}
        li.text-xs.text-destructive(v-if="missing.length") 没有这些工具：{{ missing.join('、') }}
  .oc-turn-row.text-sm.text-muted-foreground(v-else)
    TriangleAlertIcon(class="size-4 shrink-0")
    span.min-w-0.truncate {{ title }}
</template>
