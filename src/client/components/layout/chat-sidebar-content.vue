<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowLeftIcon, ChevronsUpDownIcon, PlusIcon, SearchIcon, SlidersHorizontalIcon,
} from '@lucide/vue'
import { RouterLink, useRoute } from 'vue-router'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import CollectionState from '@/client/components/collection-state.vue'
import { Button } from '@/client/ui/button'
import ProjectCreateDialog from '@/client/components/layout/project-create-dialog.vue'
import ProjectNavRow from '@/client/components/layout/project-nav-row.vue'
import SessionNavRow from '@/client/components/layout/session-nav-row.vue'
import { projectPresentation, recentProjects, searchProjects, searchSessions } from '@/client/lib/ui-models'
import { useSyncStore } from '@/client/stores/sync'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/client/ui/dropdown-menu'
import { ScrollArea } from '@/client/ui/scroll-area'
import {
  SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarGroupAction, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from '@/client/ui/sidebar'

const props = defineProps<{
  projectId?: number | null
}>()

const sync = useSyncStore()
const route = useRoute()
const query = ref('')

const project = computed(() => typeof props.projectId === 'number' ? sync.projects.get(props.projectId) : undefined)
const projectTitle = computed(() => project.value ? projectPresentation(project.value.name).title : '')
const displayProjectName = (name: string) => projectPresentation(name).title
const isProjectMode = computed(() => typeof props.projectId === 'number' && project.value !== undefined)
const allProjectsByActivity = computed(() => recentProjects(sync.projectList, sync.sessionList, Number.MAX_SAFE_INTEGER))
const visibleProjects = computed(() => {
  const source = query.value.trim()
    ? searchProjects(allProjectsByActivity.value, query.value)
    : allProjectsByActivity.value.slice(0, 5)
  return source
})
const outerSessions = computed(() => query.value.trim()
  ? searchSessions(sync.sessionList, query.value)
  : searchSessions(sync.sessionList, '', null))
const projectSessions = computed(() => searchSessions(sync.sessionList, query.value, props.projectId))
const openSessionId = computed(() => {
  const raw = 'sessionId' in route.params ? route.params.sessionId : undefined
  const value = typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isInteger(value) && value > 0 ? value : null
})

function clearSearch() {
  query.value = ''
}
</script>

<template>
  <template v-if="isProjectMode && project">
    <SidebarHeader data-project-context>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton data-project-back as-child class="min-h-10 md:min-h-0" tooltip="返回聊天">
            <RouterLink to="/new" @click="clearSearch">
              <ArrowLeftIcon />
              <span>返回聊天</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <SidebarMenuButton data-project-switcher size="lg" :tooltip="projectTitle">
                <ProjectAvatar :project="project" />
                <span class="min-w-0 flex-1 truncate font-medium">{{ projectTitle }}</span>
                <ChevronsUpDownIcon />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="min-w-56">
              <DropdownMenuLabel>切换 Project</DropdownMenuLabel>
              <DropdownMenuGroup>
                <DropdownMenuItem v-for="item in allProjectsByActivity" :key="item.id" class="min-h-10" as-child>
                  <RouterLink :to="`/project/${item.id}`">
                    <ProjectAvatar :project="item" size="sm" />
                    <span class="truncate">{{ displayProjectName(item.name) }}</span>
                  </RouterLink>
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton data-project-new-chat as-child class="min-h-10 md:min-h-0" tooltip="Project 新对话">
            <RouterLink :to="`/project/${project.id}/new`">
              <PlusIcon />
              <span>Project 新对话</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <div class="relative group-data-[collapsible=icon]:hidden">
        <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <SidebarInput v-model="query" class="min-h-10 pl-8" placeholder="搜索 Project 对话…" />
      </div>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton data-project-settings as-child class="min-h-10 md:min-h-0" tooltip="Project 设置">
            <RouterLink :to="`/project/${project.id}/settings`">
              <SlidersHorizontalIcon />
              <span>Project 设置</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>

    <SidebarContent class="overflow-hidden">
      <ScrollArea class="min-h-0 flex-1">
        <SidebarGroup>
          <SidebarGroupLabel>对话 {{ projectSessions.length }}</SidebarGroupLabel>
          <SidebarGroupContent>
            <CollectionState :loaded="sync.sessionsLoaded" :error="sync.sessionsError" :retry="sync.loadSessions" :empty="projectSessions.length === 0" :empty-title="query ? '没有匹配的对话' : '这个 Project 还没有对话'">
              <template #empty-action>
                <Button v-if="query" variant="outline" class="min-h-10" @click="clearSearch">清除搜索</Button>
                <Button v-else as-child variant="outline" class="min-h-10"><RouterLink :to="`/project/${project.id}/new`">开始对话</RouterLink></Button>
              </template>
              <SidebarMenu>
                <SessionNavRow
                  v-for="session in projectSessions" :key="session.id"
                  :session="session"
                  :projects="sync.projectList"
                  :active="openSessionId === session.id"
                />
              </SidebarMenu>
            </CollectionState>
          </SidebarGroupContent>
        </SidebarGroup>
      </ScrollArea>
    </SidebarContent>
  </template>

  <template v-else>
    <SidebarHeader>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton as-child class="min-h-10 md:min-h-0" tooltip="新建随心聊">
            <RouterLink to="/new">
              <PlusIcon />
              <span>新建随心聊</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <div class="relative group-data-[collapsible=icon]:hidden">
        <SearchIcon class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <SidebarInput v-model="query" class="min-h-10 pl-8" placeholder="搜索聊天或 Project…" />
      </div>
    </SidebarHeader>

    <SidebarContent class="overflow-hidden">
      <ScrollArea class="min-h-0 flex-1">
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <ProjectCreateDialog>
            <template #trigger>
              <SidebarGroupAction aria-label="新建 Project">
                <PlusIcon />
                <span class="sr-only">新建 Project</span>
              </SidebarGroupAction>
            </template>
          </ProjectCreateDialog>
          <SidebarGroupContent>
            <CollectionState :loaded="sync.projectsLoaded" :error="sync.projectsError" :retry="sync.loadProjects" :empty="visibleProjects.length === 0" :empty-title="query ? '没有匹配的 Project' : '还没有 Project'">
              <template #empty-action>
                <Button v-if="query" variant="outline" class="min-h-10" @click="clearSearch">清除搜索</Button>
                <ProjectCreateDialog v-else />
              </template>
              <SidebarMenu>
                <ProjectNavRow v-for="item in visibleProjects" :key="item.id" :project="item" />
              </SidebarMenu>
            </CollectionState>
            <SidebarMenu>
              <SidebarMenuItem>
                <RouterLink to="/projects" class="flex min-h-10 items-center px-2 text-xs font-normal text-muted-foreground underline-offset-4 hover:underline focus-visible:underline group-data-[collapsible=icon]:hidden">
                  查看全部 Projects
                </RouterLink>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <Collapsible default-open>
          <SidebarGroup>
            <CollapsibleTrigger as-child>
              <SidebarGroupLabel class="min-h-10 cursor-pointer md:min-h-0">{{ query.trim() ? '搜索结果' : '随心聊' }}</SidebarGroupLabel>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarGroupContent>
                <CollectionState :loaded="sync.sessionsLoaded" :error="sync.sessionsError" :retry="sync.loadSessions" :empty="outerSessions.length === 0" :empty-title="query ? '没有匹配的对话' : '还没有随心聊'">
                  <template #empty-action>
                    <Button v-if="query" variant="outline" class="min-h-10" @click="clearSearch">清除搜索</Button>
                    <Button v-else as-child variant="outline" class="min-h-10"><RouterLink to="/new">开始对话</RouterLink></Button>
                  </template>
                  <SidebarMenu>
                    <SessionNavRow
                      v-for="session in outerSessions" :key="session.id"
                      :session="session"
                      :projects="sync.projectList"
                      :active="openSessionId === session.id"
                    />
                  </SidebarMenu>
                </CollectionState>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </ScrollArea>
    </SidebarContent>

  </template>
</template>
