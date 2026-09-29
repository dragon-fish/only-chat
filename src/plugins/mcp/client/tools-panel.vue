<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCwIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { Skeleton } from '@/client/ui/skeleton'
import { Switch } from '@/client/ui/switch'
import type { McpServerView, McpToolView } from '@/shared/mcp'

const props = defineProps<{ server: McpServerView }>()
const emit = defineEmits<{ updated: [server: McpServerView] }>()

const tools = ref<McpToolView[]>([])
const instructions = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const busy = ref(false)
const query = ref('')

const visible = computed(() => {
  const search = query.value.trim().toLowerCase()
  if (!search) return tools.value
  return tools.value.filter(tool => `${tool.name}\n${tool.description ?? ''}`.toLowerCase().includes(search))
})
const enabledCount = computed(() => tools.value.filter(tool => tool.enabled).length)

async function load(refresh = false) {
  loading.value = true
  error.value = null
  try {
    const response = refresh ? await api.refreshMcpServerTools(props.server.key) : await api.mcpServerTools(props.server.key)
    tools.value = response.tools
    instructions.value = response.instructions
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    // Listing is also a connection attempt; its outcome belongs on the status badge.
    if (refresh) {
      const { servers } = await api.mcpServers()
      const current = servers.find(server => server.key === props.server.key)
      if (current) emit('updated', current)
    }
  }
}

async function setEnabled(tool: McpToolView, enabled: boolean) {
  const previous = tool.enabled
  tool.enabled = enabled
  busy.value = true
  try {
    const disabled = tools.value.filter(entry => !entry.enabled).map(entry => entry.name)
    const { server } = await api.updateMcpServer(props.server.key, { disabled_tools: disabled })
    emit('updated', server)
  } catch (cause) {
    tool.enabled = previous
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    busy.value = false
  }
}

onMounted(() => load())
</script>

<template lang="pug">
.flex.flex-col.gap-3
  .flex.flex-wrap.items-center.gap-2
    Input(v-model="query" type="search" placeholder="筛选工具…" aria-label="筛选工具" class="min-h-10 min-w-0 flex-1 md:min-h-8")
    Button(variant="outline" class="min-h-10 md:min-h-8" :disabled="loading" @click="load(true)")
      RefreshCwIcon(data-icon="inline-start")
      | 刷新
  p.text-xs.text-muted-foreground(v-if="!loading && !error") 共 {{ tools.length }} 个工具，已启用 {{ enabledCount }} 个。关闭的工具模型看不到也调不到。
  Alert(v-if="error" variant="destructive")
    AlertTitle 无法获取工具列表
    AlertDescription {{ error }}
  .flex.flex-col.gap-2(v-else-if="loading")
    Skeleton(v-for="n in 4" :key="n" class="h-12 w-full")
  template(v-else)
    details.rounded-md.border.px-3.py-2.text-sm(v-if="instructions")
      summary.cursor-pointer.text-muted-foreground 服务的使用说明
      p.mt-2.whitespace-pre-wrap.text-xs {{ instructions }}
    p.text-sm.text-muted-foreground(v-if="visible.length === 0") {{ query ? '没有匹配的工具。' : '这个服务没有提供工具。' }}
    ul.flex.flex-col.divide-y.rounded-md.border(v-else)
      li.flex.items-start.gap-3.px-3.py-2(v-for="tool in visible" :key="tool.name")
        .min-w-0.flex-1
          p.truncate.font-mono.text-sm(:title="tool.name") {{ tool.name }}
          p.line-clamp-2.text-xs.text-muted-foreground(v-if="tool.description" :title="tool.description") {{ tool.description }}
        Switch(
          :model-value="tool.enabled" :disabled="busy" :aria-label="`启用 ${tool.name}`" class="mt-1 shrink-0"
          @update:model-value="setEnabled(tool, $event)")
</template>
