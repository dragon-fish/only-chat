<script setup lang="ts">
import { computed, watch } from 'vue'
import { ArrowLeftIcon, PlusIcon, SettingsIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import SessionNavRow from '@/client/components/layout/session-nav-row.vue'
import CollectionState from '@/client/components/collection-state.vue'
import { searchSessions } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { ScrollArea } from '@/client/ui/scroll-area'

const props = defineProps<{ projectId: number | null }>()
const sync = useSyncStore()
const router = useRouter()
const project = computed(() => props.projectId === null ? undefined : sync.projects.get(props.projectId))
const sessions = computed(() => props.projectId === null ? [] : searchSessions(sync.sessionList, '', props.projectId))

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
      <ProjectAvatar :name="project.name" size="sm" />
      <span class="truncate text-sm font-medium">{{ project.name }}</span>
    </template>
    <span v-else class="truncate text-sm text-muted-foreground">加载 Project…</span>
  </Teleport>

  <ScrollArea class="h-full">
    <CollectionState v-if="!project" :loaded="sync.projectsLoaded" :error="sync.projectsError" :retry="sync.loadProjects" />
    <main v-if="project" class="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5">
      <div class="flex items-center gap-2">
        <Button as-child class="min-h-10 flex-1">
          <RouterLink :to="{ path: '/', query: { project: project.id } }">
            <PlusIcon data-icon="inline-start" />
            Project 新对话
          </RouterLink>
        </Button>
        <Button as-child variant="outline" class="min-h-10">
          <RouterLink :to="`/settings/projects/${project.id}`">
            <SettingsIcon data-icon="inline-start" />
            设置
          </RouterLink>
        </Button>
      </div>

      <section class="flex flex-col gap-2" aria-labelledby="oc-project-sessions">
        <h2 id="oc-project-sessions" class="min-h-10 px-2 py-2 text-sm font-medium">对话 {{ sessions.length }}</h2>
        <CollectionState :loaded="sync.sessionsLoaded" :error="sync.sessionsError" :retry="sync.loadSessions" :empty="sessions.length === 0" empty-title="还没有对话" empty-description="在这个 Project 中开始一段新对话。">
          <SessionNavRow v-for="session in sessions" :key="session.id" :session="session" :projects="sync.projectList" />
          <template #empty-action>
            <Button as-child class="min-h-10">
              <RouterLink :to="{ path: '/', query: { project: project.id } }">开始对话</RouterLink>
            </Button>
          </template>
        </CollectionState>
      </section>
    </main>
  </ScrollArea>
</template>
