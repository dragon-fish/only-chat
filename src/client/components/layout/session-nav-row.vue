<script setup lang="ts">
import { computed } from 'vue'
import { FolderInputIcon, Trash2Icon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { DISCONNECTED_MESSAGE, moveSessionCommand, useSyncStore } from '@/client/stores/sync'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/client/ui/dropdown-menu'
import type { Project, Session } from '@/shared/models'

const props = defineProps<{
  session: Session
  projects: readonly Project[]
  active?: boolean
}>()

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()

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
  <div
    :class="cn(
      'group/session flex min-h-10 min-w-0 items-center rounded-md',
      active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent',
    )"
  >
    <RouterLink class="flex min-h-10 min-w-0 flex-1 items-center px-2 text-sm" :to="`/c/${session.id}`" @click="emit('navigate')">
      <span class="truncate">{{ session.title }}</span>
    </RouterLink>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-10 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/session:opacity-100 md:focus-visible:opacity-100"
          aria-label="移动对话"
        >
          <FolderInputIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" class="min-w-44">
        <DropdownMenuLabel>移动到</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem v-for="target in moveTargets" :key="target.id ?? 'none'" class="min-h-10" @select="move(target.id)">
            {{ target.label }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="moveTargets.length === 0" class="min-h-10" disabled>还没有其他 Project</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>

    <AlertDialog>
      <AlertDialogTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-10 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/session:opacity-100 md:focus-visible:opacity-100"
          aria-label="删除对话"
        >
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
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
  </div>
</template>
