<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ImageIcon, ImagesIcon, PlusIcon } from '@lucide/vue'
import { RouterLink, useRoute } from 'vue-router'
import CollectionState from '@/client/components/collection-state.vue'
import { api } from '@/client/lib/api'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { ScrollArea } from '@/client/ui/scroll-area'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/client/ui/sidebar'

const route = useRoute()
const sync = useSyncStore()
const conversations = computed(() => sync.imageConversationList)
const loaded = ref(false)
const error = ref<string | null>(null)
const activeId = computed(() => {
  const value = (route.params as Record<string, unknown>).conversationId
  const id = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(id) && id > 0 ? id : null
})
async function load() {
  error.value = null
  try { sync.ingestConversations(await api.imageConversations()); loaded.value = true }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
}
onMounted(load)
</script>

<template>
  <SidebarHeader data-image-context>
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton as-child class="min-h-10 md:min-h-0" tooltip="图片 Gallery" :is-active="route.path === '/images'">
          <RouterLink to="/images"><ImagesIcon /><span>图片 Gallery</span></RouterLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton as-child class="min-h-10 md:min-h-0" tooltip="新建图片">
          <RouterLink to="/images/new"><PlusIcon /><span>图片 Studio</span></RouterLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  </SidebarHeader>
  <SidebarContent class="overflow-hidden">
    <ScrollArea class="min-h-0 flex-1">
      <SidebarGroup>
        <SidebarGroupLabel>创作历史</SidebarGroupLabel>
        <SidebarGroupContent>
          <CollectionState :loaded="loaded" :error="error" :retry="load" :empty="conversations.length === 0" empty-title="还没有创作历史">
            <template #empty-action><Button as-child variant="outline"><RouterLink to="/images/new">开始创作</RouterLink></Button></template>
            <SidebarMenu>
              <SidebarMenuItem v-for="conversation in conversations" :key="conversation.id">
                <SidebarMenuButton as-child class="min-h-10 md:min-h-0" :is-active="activeId === conversation.id" :tooltip="conversation.title">
                  <RouterLink :to="`/images/s/${conversation.id}`"><ImageIcon /><span class="truncate">{{ conversation.title }}</span></RouterLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </CollectionState>
        </SidebarGroupContent>
      </SidebarGroup>
    </ScrollArea>
  </SidebarContent>
</template>
