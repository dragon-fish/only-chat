<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ChevronDown, ChevronRight, Folder, FolderInput, Pencil, Plus, X } from '@lucide/vue'
import { Input } from '@/client/ui/input'
import { moveSessionCommand, useSyncStore } from '@/client/stores/sync'
import { routeParamToId } from '@/client/lib/route-params'
import type { Project, Session } from '@/shared/models'

interface TreeGroup {
  /** `null` is the unprojected Chats section, which renders the same chat rows without a folder row. */
  project: Project | null
  chats: Session[]
}

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
const route = useRoute()
const router = useRouter()

const expanded = ref(new Set<number>())
// Two-step confirm, matching the session rows: first click arms the row, second click deletes.
const pendingSessionId = ref<number | null>(null)
const pendingProjectId = ref<number | null>(null)
const movingId = ref<number | null>(null)
const creating = ref(false)
const newName = ref('')
// The server never echoes our `request_id` back, so a create is matched by the name we sent:
// until a Project with that name shows up the input keeps what the user typed (spec §9).
const submittedName = ref<string | null>(null)

const groups = computed<TreeGroup[]>(() => [
  ...sync.projectList.map((p) => ({ project: p, chats: sync.sessionsInProject(p.id) })),
  { project: null, chats: sync.sessionsInProject(null) },
])
const openSessionId = computed(() => routeParamToId('sessionId' in route.params ? route.params.sessionId : undefined))

// Keep the open chat reachable: its Project expands as soon as the session row is known, which
// may be after the first paint because sessions load asynchronously.
watchEffect(() => {
  const id = openSessionId.value
  const projectId = id === null ? null : sync.sessions.get(id)?.project_id ?? null
  if (projectId !== null) expanded.value.add(projectId)
})

watchEffect(() => {
  const name = submittedName.value
  if (name !== null && sync.projectList.some((p) => p.name === name)) {
    submittedName.value = null
    newName.value = ''
    creating.value = false
  }
})

function isExpanded(projectId: number): boolean {
  return expanded.value.has(projectId)
}

function toggle(projectId: number): void {
  if (!expanded.value.delete(projectId)) expanded.value.add(projectId)
}

/** Anything armed by a previous click reverts as soon as a click lands elsewhere. */
function clearTransient() {
  pendingSessionId.value = null
  pendingProjectId.value = null
  movingId.value = null
}

function startCreate() {
  creating.value = true
  clearTransient()
}

function createProject() {
  const name = newName.value.trim()
  if (!name) return
  submittedName.value = name
  sync.send({ type: 'project.create', name })
}

function cancelCreate() {
  creating.value = false
  submittedName.value = null
  newName.value = ''
}

function onDeleteProject(projectId: number) {
  if (pendingProjectId.value !== projectId) {
    clearTransient()
    pendingProjectId.value = projectId
    return
  }
  clearTransient()
  // Deletion is never optimistic: the row disappears only when `project.deleted` arrives, and the
  // Project's chats come back in the Chats section rather than being removed (spec §3.1/§9).
  sync.send({ type: 'project.delete', project_id: projectId })
}

function onDeleteSession(sessionId: number) {
  if (pendingSessionId.value !== sessionId) {
    clearTransient()
    pendingSessionId.value = sessionId
    return
  }
  clearTransient()
  sync.send({ type: 'session.delete', session_id: sessionId })
  if (openSessionId.value === sessionId) router.push('/')
}

function startMove(sessionId: number) {
  const open = movingId.value === sessionId
  clearTransient()
  if (!open) movingId.value = sessionId
}

/** Every Project except the one the chat already sits in, plus the way back out to Chats. */
function moveTargets(s: Session): Array<{ id: number | null; label: string }> {
  return [
    ...(s.project_id === null ? [] : [{ id: null, label: '移出项目' }]),
    ...sync.projectList.filter((p) => p.id !== s.project_id).map((p) => ({ id: p.id, label: p.name })),
  ]
}

function move(sessionId: number, projectId: number | null) {
  clearTransient()
  sync.send(moveSessionCommand(sessionId, projectId))
}

onMounted(() => window.addEventListener('click', clearTransient))
onUnmounted(() => window.removeEventListener('click', clearTransient))
</script>

<template lang="pug">
.oc-scroll.min-h-0.flex-1.overflow-y-auto.px-2.pb-2
  .flex.items-center.justify-between.px-2.pt-2.pb-1
    span.text-xs.font-medium.text-muted-foreground 项目
    button.inline-flex.items-center.rounded-md.p-1.text-muted-foreground(
      class="hover:bg-accent hover:text-foreground" title="新建项目" @click.stop="startCreate")
      Plus(class="size-3.5")
  .px-1.pb-1(v-if="creating")
    Input(
      v-model="newName" class="h-8 text-sm" placeholder="项目名称，回车创建" autofocus
      @keydown.enter="createProject" @keydown.esc="cancelCreate")

  template(v-for="g in groups" :key="g.project ? `p${g.project.id}` : 'chats'")
    .group.flex.items-center.gap-1.rounded-md.px-2.py-1.text-sm(v-if="g.project" class="hover:bg-accent")
      button.flex.min-w-0.flex-1.items-center.gap-1.text-left(@click.stop="toggle(g.project.id)")
        ChevronDown(v-if="isExpanded(g.project.id)" class="size-3.5 shrink-0 text-muted-foreground")
        ChevronRight(v-else class="size-3.5 shrink-0 text-muted-foreground")
        Folder(class="size-3.5 shrink-0 text-muted-foreground")
        span.truncate {{ g.project.name }}
      template(v-if="pendingProjectId === g.project.id")
        button.shrink-0.text-xs(class="text-destructive" @click.stop="onDeleteProject(g.project.id)") 确认删除
      template(v-else)
        .flex.shrink-0.items-center.gap-1.text-muted-foreground(
          class="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100")
          RouterLink(
            :to="{ path: '/', query: { project: g.project.id } }" title="在此项目中新建聊天"
            @click="emit('navigate')")
            Plus(class="size-3.5")
          RouterLink(:to="`/settings/projects/${g.project.id}`" title="项目设置" @click="emit('navigate')")
            Pencil(class="size-3.5")
          button(title="删除项目" @click.stop="onDeleteProject(g.project.id)")
            X(class="size-3.5")
    .px-2.pt-3.pb-1(v-else)
      span.text-xs.font-medium.text-muted-foreground 最近

    //- Collapsed Project rows preview their latest chat instead of the whole list.
    p.truncate.px-2.text-xs.text-muted-foreground(v-if="g.project && !isExpanded(g.project.id)" class="pl-6")
      | {{ g.chats[0]?.title ?? '暂无聊天' }}
    template(v-else)
      p.px-2.py-1.text-xs.text-muted-foreground(v-if="!g.chats.length" :class="g.project ? 'pl-6' : 'pl-2'") 暂无聊天
      div(v-for="s in g.chats" :key="s.id" :class="g.project ? 'pl-4' : ''")
        .group.flex.items-center.gap-1.rounded-md.px-2.py-1.text-sm(
          :class="openSessionId === s.id ? 'bg-accent' : 'hover:bg-accent'")
          RouterLink.min-w-0.flex-1.truncate(:to="`/c/${s.id}`" @click="emit('navigate')") {{ s.title }}
          template(v-if="pendingSessionId === s.id")
            button.shrink-0.text-xs(class="text-destructive" @click.stop="onDeleteSession(s.id)") 确认删除
          template(v-else)
            .flex.shrink-0.items-center.gap-1.text-muted-foreground(
              class="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100")
              button(title="移动到项目" @click.stop="startMove(s.id)")
                FolderInput(class="size-3.5")
              button(title="删除对话" @click.stop="onDeleteSession(s.id)")
                X(class="size-3.5")
        .mx-2.mb-1.flex.flex-col.rounded-md.border.bg-popover.p-1(v-if="movingId === s.id")
          button.rounded.px-2.py-1.text-left.text-xs(
            v-for="t in moveTargets(s)" :key="t.id ?? 'none'" class="hover:bg-accent"
            @click.stop="move(s.id, t.id)") {{ t.label }}
          p.px-2.py-1.text-xs.text-muted-foreground(v-if="!moveTargets(s).length") 还没有其他项目
</template>
