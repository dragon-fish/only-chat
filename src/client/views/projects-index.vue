<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeftIcon, SearchIcon } from '@lucide/vue'
import ProjectCreateDialog from '@/client/components/layout/project-create-dialog.vue'
import ProjectNavRow from '@/client/components/layout/project-nav-row.vue'
import CollectionState from '@/client/components/collection-state.vue'
import { recentProjects, searchProjects } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
import { ScrollArea } from '@/client/ui/scroll-area'

const sync = useSyncStore()
const query = ref('')
const projects = computed(() => searchProjects(
  recentProjects(sync.projectList, sync.sessionList, Number.MAX_SAFE_INTEGER),
  query.value,
))
</script>

<template>
  <Teleport to="#page-header">
    <Button as-child variant="ghost" size="icon-sm" class="size-10">
      <RouterLink to="/chats" aria-label="返回聊天">
        <ArrowLeftIcon />
      </RouterLink>
    </Button>
    <span class="truncate text-sm font-medium">全部 Projects</span>
  </Teleport>

  <ScrollArea class="h-full">
    <main class="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5">
      <div class="flex items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="query" class="min-h-10 pl-8" placeholder="搜索 Projects…" />
        </div>
        <ProjectCreateDialog />
      </div>

      <CollectionState :loaded="sync.projectsLoaded" :error="sync.projectsError" :retry="sync.loadProjects" :empty="projects.length === 0" :empty-title="query ? '没有匹配的 Project' : '还没有 Project'" empty-description="创建一个 Project 开始整理对话，或换个关键词再试。">
        <ProjectNavRow v-for="project in projects" :key="project.id" :project="project" />
        <template #empty-action>
          <Button v-if="query" variant="outline" class="min-h-10" @click="query = ''">清除搜索</Button>
          <ProjectCreateDialog v-else />
        </template>
      </CollectionState>
    </main>
  </ScrollArea>
</template>
