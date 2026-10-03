<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PlusIcon } from '@lucide/vue'
import CollectionState from '@/client/components/collection-state.vue'
import { api } from '@/client/lib/api'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { MCP_MAX_SERVERS, type McpServerView } from '@/shared/mcp'
import ServerDetail from './server-detail.vue'
import { STATUS_LABELS, statusVariant, TRANSPORT_LABELS } from './format'

const route = useRoute()
const router = useRouter()
const servers = ref<McpServerView[]>([])
const loaded = ref(false)
const loadError = ref<string | null>(null)

/** `?server=<key>` opens one; `?server=new` is the form for adding one. The list is everything else. */
const selectedKey = computed(() => (typeof route.query.server === 'string' ? route.query.server : null))
const selected = computed(() => servers.value.find(server => server.key === selectedKey.value) ?? null)
const showDetail = computed(() => selectedKey.value === 'new' || selected.value !== null)

async function load() {
  loadError.value = null
  try { servers.value = (await api.mcpServers()).servers }
  catch (cause) { loadError.value = cause instanceof Error ? cause.message : String(cause) }
  finally { loaded.value = true }
}

function open(key: string | null) {
  void router.replace({ query: { ...route.query, server: key ?? undefined } })
}

function saved(server: McpServerView) {
  const index = servers.value.findIndex(entry => entry.key === server.key)
  if (index === -1) servers.value.push(server)
  else servers.value[index] = server
  if (selectedKey.value === 'new') open(server.key)
}

function deleted() {
  servers.value = servers.value.filter(server => server.key !== selectedKey.value)
  open(null)
}

onMounted(load)
</script>

<template lang="pug">
.flex.flex-col.gap-4
  ServerDetail(
    v-if="loaded && showDetail" :key="selectedKey ?? ''" :server="selected"
    @saved="saved" @deleted="deleted" @back="open(null)")
  template(v-else)
    .flex.flex-wrap.items-center.justify-between.gap-2
      p.text-sm.text-muted-foreground 模型通过「MCP 服务」工具组调用这里启用的服务。
      Button(variant="outline" class="min-h-10 md:min-h-8" :disabled="servers.length >= MCP_MAX_SERVERS" @click="open('new')")
        PlusIcon(data-icon="inline-start")
        | 添加服务
    CollectionState(
      :loaded="loaded" :error="loadError" :retry="load" :empty="!servers.length"
      empty-title="还没有 MCP 服务" empty-description="添加一个远程 MCP 服务地址，例如百炼上的在线 MCP 或 Notion。")
      template(#empty-action)
        Button(variant="outline" class="min-h-10" @click="open('new')") 添加服务
      ItemGroup(class="gap-2")
        Item(v-for="server in servers" :key="server.key" as-child variant="outline" size="sm" class="hover:bg-muted/60")
          button.w-full.text-left(type="button" @click="open(server.key)")
            ItemContent
              ItemTitle {{ server.name }}
              ItemDescription.truncate.font-mono {{ server.url }}
              .flex.flex-wrap.gap-1
                Badge(:variant="statusVariant(server.status)") {{ STATUS_LABELS[server.status] }}
                Badge(variant="outline") {{ TRANSPORT_LABELS[server.transport] }}
                Badge(v-if="!server.enabled" variant="outline") 已停用
</template>
