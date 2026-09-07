<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderKanbanIcon, MessageCircleIcon, SearchIcon } from '@lucide/vue'
import ProjectNavRow from '@/client/components/layout/project-nav-row.vue'
import SessionNavRow from '@/client/components/layout/session-nav-row.vue'
import { recentProjects, searchProjects, searchSessions } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Input } from '@/client/ui/input'
import { ScrollArea } from '@/client/ui/scroll-area'

const sync = useSyncStore()
const query = ref('')

const allProjectsByActivity = computed(() => recentProjects(sync.projectList, sync.sessionList, Number.MAX_SAFE_INTEGER))
const projects = computed(() => {
  const source = query.value.trim() ? allProjectsByActivity.value : allProjectsByActivity.value.slice(0, 5)
  return searchProjects(source, query.value)
})
const sessions = computed(() => query.value.trim()
  ? searchSessions(sync.sessionList, query.value)
  : searchSessions(sync.sessionList, '', null))
</script>

<template>
  <Teleport to="#page-header">
    <span class="truncate text-sm font-medium">聊天</span>
  </Teleport>

  <ScrollArea class="h-full">
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5">
      <div class="relative">
        <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" class="min-h-10 pl-8" placeholder="搜索聊天或 Project…" />
      </div>

      <section class="flex flex-col gap-2" aria-labelledby="oc-chat-projects">
        <div class="flex min-h-10 items-center gap-2">
          <FolderKanbanIcon />
          <h2 id="oc-chat-projects" class="text-sm font-medium">Projects</h2>
          <RouterLink class="ml-auto text-sm text-muted-foreground hover:text-foreground" to="/projects">查看全部</RouterLink>
        </div>
        <div class="flex flex-col gap-1">
          <ProjectNavRow v-for="project in projects" :key="project.id" :project="project" />
          <Empty v-if="projects.length === 0">
            <EmptyHeader>
              <EmptyTitle>{{ query ? '没有匹配的 Project' : '还没有 Project' }}</EmptyTitle>
              <EmptyDescription>{{ query ? '换个关键词再试。' : '创建 Project 后会显示在这里。' }}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </section>

      <section class="flex flex-col gap-2" aria-labelledby="oc-free-chats">
        <div class="flex min-h-10 items-center gap-2">
          <MessageCircleIcon />
          <h2 id="oc-free-chats" class="text-sm font-medium">{{ query.trim() ? '搜索结果' : '随心聊' }}</h2>
        </div>
        <div class="flex flex-col gap-1">
          <SessionNavRow v-for="session in sessions" :key="session.id" :session="session" :projects="sync.projectList" />
          <Empty v-if="sessions.length === 0">
            <EmptyHeader>
              <EmptyTitle>{{ query ? '没有匹配的对话' : '还没有随心聊' }}</EmptyTitle>
              <EmptyDescription>{{ query ? '换个关键词再试。' : '点底部加号就能开始。' }}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </section>
    </main>
  </ScrollArea>
</template>
