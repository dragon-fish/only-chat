<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { EllipsisIcon, Trash2Icon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { DISCONNECTED_MESSAGE, moveSessionCommand, useSyncStore } from '@/client/stores/sync'
import { sessionPath } from '@/client/lib/ui-models'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/client/ui/sidebar'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/client/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/client/ui/dropdown-menu'
import type { Project, Session } from '@/shared/models'

const props = defineProps<{
  session: Session
  projects: readonly Project[]
  active?: boolean
}>()

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
const { isMobile } = useSidebar()
const deleteOpen = ref(false)
const action = ref<InstanceType<typeof SidebarMenuAction> | null>(null)

function restoreActionFocus(event: Event) {
  event.preventDefault()
  void nextTick(() => {
    const element = action.value?.$el
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true })
  })
}

const moveTargets = computed(() => [
  ...(props.session.project_id === null ? [] : [{ id: null, label: '移出 Project' }]),
  ...props.projects
    .filter(project => project.id !== props.session.project_id)
    .map(project => ({ id: project.id, label: project.name })),
])

function move(projectId: number | null) {
  send(moveSessionCommand(props.session.id, projectId))
}

function remove() {
  send({ type: 'session.delete', session_id: props.session.id })
}

function send(command: Parameters<typeof sync.send>[0]): boolean {
  sync.lastError = null
  if (sync.send(command)) return true
  sync.lastError = DISCONNECTED_MESSAGE
  return false
}
</script>

<template>
  <SidebarMenuItem>
    <SidebarMenuButton as-child size="lg" class="h-10" :is-active="active">
      <RouterLink :to="sessionPath(session)" @click="emit('navigate')">
        <span>{{ session.title }}</span>
      </RouterLink>
    </SidebarMenuButton>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <SidebarMenuAction ref="action" show-on-hover type="button" :aria-label="`对话操作：${session.title}`">
          <EllipsisIcon />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent :side="isMobile ? 'bottom' : 'right'" :align="isMobile ? 'end' : 'start'" class="min-w-44" @close-auto-focus="event => { if (deleteOpen) event.preventDefault() }">
        <DropdownMenuGroup>
          <DropdownMenuLabel>移动到</DropdownMenuLabel>
          <DropdownMenuItem v-for="target in moveTargets" :key="target.id ?? 'none'" class="min-h-10" @select="move(target.id)">
            {{ target.label }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="moveTargets.length === 0" class="min-h-10" disabled>还没有其他 Project</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" class="min-h-10" @select="deleteOpen = true">
            <Trash2Icon />
            <span>删除对话</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent @close-auto-focus="restoreActionFocus">
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个对话？</AlertDialogTitle>
          <AlertDialogDescription>“{{ session.title }}”及其所有消息将被永久删除。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="min-h-10">取消</AlertDialogCancel>
          <AlertDialogAction class="min-h-10" variant="destructive" @click="remove">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SidebarMenuItem>
</template>
