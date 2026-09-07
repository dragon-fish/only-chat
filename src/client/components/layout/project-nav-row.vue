<script setup lang="ts">
import { Trash2Icon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import { cn } from '@/client/lib/utils'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Button } from '@/client/ui/button'
import type { Project } from '@/shared/models'

const props = defineProps<{
  project: Project
  active?: boolean
}>()

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()

function remove() {
  sync.lastError = null
  if (!sync.send({ type: 'project.delete', project_id: props.project.id })) {
    sync.lastError = DISCONNECTED_MESSAGE
  }
}
</script>

<template>
  <div
    :class="cn(
      'group/project flex min-h-10 min-w-0 items-center rounded-md',
      active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'hover:bg-sidebar-accent',
    )"
  >
    <RouterLink class="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2 text-sm" :to="`/project/${project.id}`" @click="emit('navigate')">
      <ProjectAvatar :name="project.name" size="sm" />
      <span class="truncate">{{ project.name }}</span>
    </RouterLink>
    <AlertDialog>
      <AlertDialogTrigger as-child>
        <Button
          variant="ghost"
          size="icon-sm"
          class="size-10 shrink-0 text-muted-foreground md:opacity-0 md:group-hover/project:opacity-100 md:focus-visible:opacity-100"
          aria-label="删除 Project"
        >
          <Trash2Icon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这个 Project？</AlertDialogTitle>
          <AlertDialogDescription>“{{ project.name }}”将被删除，其中的对话会移到随心聊。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="min-h-10">取消</AlertDialogCancel>
          <AlertDialogAction class="min-h-10" variant="destructive" @click="remove">
            <Trash2Icon data-icon="inline-start" />
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
