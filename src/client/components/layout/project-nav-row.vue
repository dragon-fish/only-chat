<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { EllipsisIcon, Trash2Icon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import { DISCONNECTED_MESSAGE, useSyncStore } from '@/client/stores/sync'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/client/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger,
} from '@/client/ui/dropdown-menu'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/client/ui/sidebar'
import type { Project } from '@/shared/models'

const props = defineProps<{
  project: Project
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

function remove() {
  sync.lastError = null
  if (!sync.send({ type: 'project.delete', project_id: props.project.id })) {
    sync.lastError = DISCONNECTED_MESSAGE
  }
}
</script>

<template>
  <SidebarMenuItem>
    <SidebarMenuButton as-child class="min-h-10 md:min-h-0 group-has-data-[sidebar=menu-action]/menu-item:pr-12" :is-active="active" :tooltip="project.name">
      <RouterLink :to="`/project/${project.id}`" @click="emit('navigate')">
        <ProjectAvatar :name="project.name" size="sm" />
        <span>{{ project.name }}</span>
      </RouterLink>
    </SidebarMenuButton>
    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <SidebarMenuAction ref="action" data-row-action show-on-hover type="button" class="size-8 w-8 h-8 max-md:size-10 [&>svg]:size-4" :aria-label="`Project 操作：${project.name}`">
          <EllipsisIcon class="size-4" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent :side="isMobile ? 'bottom' : 'right'" :align="isMobile ? 'end' : 'start'" @close-auto-focus="event => { if (deleteOpen) event.preventDefault() }">
        <DropdownMenuGroup>
          <DropdownMenuItem variant="destructive" class="min-h-10" @select="deleteOpen = true">
            <Trash2Icon />
            <span>删除 Project</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent @close-auto-focus="restoreActionFocus">
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
  </SidebarMenuItem>
</template>
