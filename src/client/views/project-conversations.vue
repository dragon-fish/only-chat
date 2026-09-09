<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowLeftIcon, PlusIcon, SettingsIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import { projectPresentation, searchConversations } from '@/client/lib/ui-models'
import ConversationNavRow from '@/client/components/layout/conversation-nav-row.vue'
import CollectionState from '@/client/components/collection-state.vue'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { ScrollArea } from '@/client/ui/scroll-area'
import { SidebarMenu } from '@/client/ui/sidebar'

const props = defineProps<{ projectId: number | null }>()
const sync = useSyncStore()
const router = useRouter()
const project = computed(() => props.projectId === null ? undefined : sync.projects.get(props.projectId))
const projectTitle = computed(() => project.value ? projectPresentation(project.value.name).title : '')
const query = ref('')
const conversations = computed(() => props.projectId === null ? [] : searchConversations(sync.conversationList, query.value, props.projectId))
watch(() => props.projectId, () => { query.value = '' })

watch([() => sync.projectsLoaded, project], ([loaded, value]) => {
  if (loaded && !value) void router.replace('/projects')
}, { immediate: true })
</script>

<template>
  <Teleport to="#page-header">
    <Button as-child variant="ghost" size="icon-sm" class="size-10">
      <RouterLink to="/chats" aria-label="返回聊天">
        <ArrowLeftIcon />
      </RouterLink>
    </Button>
    <template v-if="project">
      <ProjectAvatar :project="project" size="sm" />
      <span class="truncate text-sm font-medium">{{ projectTitle }}</span>
    </template>
    <span v-else class="truncate text-sm text-muted-foreground">加载 Project…</span>
  </Teleport>

  <ScrollArea class="h-full">
    <CollectionState v-if="!project" :loaded="sync.projectsLoaded" :error="sync.projectsError" :retry="sync.loadProjects" />
    <main v-if="project" class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
      <div class="flex items-center gap-2">
        <Button as-child class="min-h-10 flex-1">
          <RouterLink :to="`/project/${project.id}/new`">
            <PlusIcon data-icon="inline-start" />
            Project 新对话
          </RouterLink>
        </Button>
        <Button as-child variant="outline" class="min-h-10">
          <RouterLink :to="`/project/${project.id}/settings`">
            <SettingsIcon data-icon="inline-start" />
            设置
          </RouterLink>
        </Button>
      </div>

      <FieldGroup>
        <Field>
          <FieldLabel for="project-conversation-search" class="sr-only">搜索 Project 内对话</FieldLabel>
          <Input id="project-conversation-search" v-model="query" type="search" aria-label="搜索 Project 内对话" placeholder="搜索 Project 内对话…" class="min-h-10" />
        </Field>
      </FieldGroup>

      <section class="flex flex-col gap-2" aria-labelledby="oc-project-conversations">
        <h2 id="oc-project-conversations" class="min-h-10 px-2 py-2 text-sm font-medium">对话 {{ conversations.length }}</h2>
        <CollectionState :loaded="sync.conversationsLoaded" :error="sync.conversationsError" :retry="sync.loadConversations" :empty="conversations.length === 0" :empty-title="query.trim() ? '没有匹配的对话' : '还没有对话'" :empty-description="query.trim() ? '试试其他关键词。' : '在这个 Project 中开始一段新对话。'">
          <SidebarMenu>
            <ConversationNavRow v-for="conversation in conversations" :key="conversation.id" :conversation="conversation" :projects="sync.projectList" />
          </SidebarMenu>
          <template #empty-action>
            <Button v-if="query.trim()" variant="outline" class="min-h-10" @click="query = ''">清除搜索</Button>
            <Button v-else as-child class="min-h-10">
              <RouterLink :to="`/project/${project.id}/new`">开始对话</RouterLink>
            </Button>
          </template>
        </CollectionState>
      </section>
    </main>
  </ScrollArea>
</template>
