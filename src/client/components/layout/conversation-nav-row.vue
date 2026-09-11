<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { DownloadIcon, EllipsisIcon, FolderInputIcon, GitForkIcon, MessageCircleIcon, PencilIcon, Trash2Icon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { toast } from 'vue-sonner'
import { useConversationFork } from '@/client/composables/use-conversation-fork'
import { api } from '@/client/lib/api'
import { conversationExport, type ExportFormat } from '@/client/lib/conversation-export'
import { DISCONNECTED_MESSAGE, moveConversationCommand, useSyncStore } from '@/client/stores/sync'
import { conversationPath } from '@/client/lib/ui-models'
import { SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/client/ui/sidebar'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/client/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/client/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import { Input } from '@/client/ui/input'
import { Button } from '@/client/ui/button'
import type { Project, Conversation } from '@/shared/models'

const props = defineProps<{
  conversation: Conversation
  projects: readonly Project[]
  active?: boolean
}>()

const emit = defineEmits<{ navigate: [] }>()
const sync = useSyncStore()
const { isMobile } = useSidebar()
const deleteOpen = ref(false)
const action = ref<InstanceType<typeof SidebarMenuAction> | null>(null)
const renameOpen = ref(false)
const title = ref(props.conversation.title)
const { pending: forkPending, fork } = useConversationFork()
watch(() => props.conversation.title, value => { if (!renameOpen.value) title.value = value })

function restoreActionFocus(event: Event) {
  event.preventDefault()
  void nextTick(() => {
    const element = action.value?.$el
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true })
  })
}

const moveTargets = computed(() => [
  ...(props.conversation.project_id === null ? [] : [{ id: null, label: '移出 Project' }]),
  ...props.projects
    .filter(project => project.id !== props.conversation.project_id)
    .map(project => ({ id: project.id, label: project.name })),
])

function move(projectId: number | null) {
  send(moveConversationCommand(props.conversation.id, projectId))
}

function remove() {
  send({ type: 'conversation.delete', conversation_id: props.conversation.id })
}

function rename() {
  const value = title.value.trim()
  if (!value || value === props.conversation.title) { renameOpen.value = false; return }
  if (send({ type: 'conversation.update', conversation_id: props.conversation.id, title: value })) renameOpen.value = false
}

async function exportConversation(format: ExportFormat) {
  try {
    await sync.loadMessages(props.conversation.id)
    conversationExport(format, {
      conversation: props.conversation,
      project: props.conversation.project_id === null ? undefined : sync.projects.get(props.conversation.project_id),
      messages: sync.pathFor(props.conversation.id),
      attachmentUrl: id => new URL(api.attachmentUrl(id), location.origin).href,
    })
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
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
    <SidebarMenuButton as-child class="min-h-10 md:min-h-0 group-has-data-[sidebar=menu-action]/menu-item:pr-12" :is-active="active" :tooltip="conversation.title">
      <RouterLink :to="conversationPath(conversation)" @click="emit('navigate')">
        <MessageCircleIcon />
        <span>{{ conversation.title }}</span>
      </RouterLink>
    </SidebarMenuButton>

    <DropdownMenu>
      <DropdownMenuTrigger as-child>
        <SidebarMenuAction ref="action" data-row-action show-on-hover type="button" class="peer-data-[size=default]/menu-button:top-1/2 -translate-y-1/2 size-8 w-8 h-8 max-md:size-10 after:inset-0 [&>svg]:size-4" :aria-label="`对话操作：${conversation.title}`">
          <EllipsisIcon class="size-4" />
        </SidebarMenuAction>
      </DropdownMenuTrigger>
      <DropdownMenuContent :side="isMobile ? 'bottom' : 'right'" :align="isMobile ? 'end' : 'start'" class="min-w-44" @close-auto-focus="event => { if (deleteOpen) event.preventDefault() }">
        <DropdownMenuGroup>
          <DropdownMenuItem class="min-h-10" @select="renameOpen = true">
            <PencilIcon /><span>重命名</span>
          </DropdownMenuItem>
          <DropdownMenuItem class="min-h-10" :disabled="conversation.head_message_id === null || !!forkPending" @select="conversation.head_message_id !== null && fork(conversation.id, conversation.head_message_id)">
            <GitForkIcon /><span>从此处分叉</span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger class="min-h-10"><DownloadIcon /><span>导出</span></DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem class="min-h-10" @select="exportConversation('markdown')">Markdown</DropdownMenuItem>
              <DropdownMenuItem class="min-h-10" @select="exportConversation('json')">JSON</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger class="min-h-10"><FolderInputIcon /><span>移动到</span></DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem v-for="target in moveTargets" :key="target.id ?? 'none'" class="min-h-10" @select="move(target.id)">{{ target.label }}</DropdownMenuItem>
              <DropdownMenuItem v-if="moveTargets.length === 0" class="min-h-10" disabled>还没有其他 Project</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
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
          <AlertDialogDescription>“{{ conversation.title }}”及其所有消息将被永久删除。</AlertDialogDescription>
          <!-- Says what survives, because both of these used to be destroyed silently. -->
          <ul class="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
            <li>生成的图片会保留在 Gallery，要删请去那里删。</li>
            <li>对话里的工作区文件会移入「悬空文件」，30 天后自动清除。</li>
          </ul>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel class="min-h-10">取消</AlertDialogCancel>
          <AlertDialogAction class="min-h-10" variant="destructive" @click="remove">删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog v-model:open="renameOpen">
      <DialogContent>
        <DialogHeader><DialogTitle>重命名对话</DialogTitle></DialogHeader>
        <form class="contents" @submit.prevent="rename">
          <Input v-model="title" class="min-h-10" maxlength="200" autofocus aria-label="对话名称" />
          <DialogFooter>
            <Button type="button" variant="outline" class="min-h-10" @click="renameOpen = false">取消</Button>
            <Button type="submit" class="min-h-10" :disabled="!title.trim()">保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </SidebarMenuItem>
</template>
