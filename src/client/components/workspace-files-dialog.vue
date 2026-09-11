<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderOpenIcon } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/client/ui/dialog'
import WorkspaceFilePanel from '@/client/components/workspace-file-panel.vue'

const props = withDefaults(defineProps<{
  mount: 'project' | 'conversation'
  /** Null before the conversation or Project exists, which is also when it can hold no files. */
  scopeId: number | null
  /** The project view wants a labelled button; the chat header has room only for the icon. */
  label?: boolean
}>(), { label: false })

const open = ref(false)
const title = computed(() => (props.mount === 'project' ? 'Project 文件' : '会话文件'))
const hint = computed(() => (props.mount === 'project'
  ? '模型在这个 Project 里读写的文件。'
  : '模型在这次会话里读写的文件。'))
</script>

<template lang="pug">
Dialog(v-if="scopeId !== null" v-model:open="open")
  DialogTrigger(as-child)
    Button(
      :variant="label ? 'outline' : 'ghost'" :size="label ? 'default' : 'icon-xs'"
      :class="label ? 'min-h-10' : 'min-h-10 min-w-10 md:min-h-6 md:min-w-6'"
      :title="title" :aria-label="title")
      FolderOpenIcon(:data-icon="label ? 'inline-start' : undefined")
      template(v-if="label") 文件
  DialogContent(class="flex max-h-[85dvh] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl")
    DialogHeader(class="px-4 pt-4")
      DialogTitle(class="text-sm") {{ title }}
      DialogDescription(class="text-xs") {{ hint }}
    .oc-scroll.min-h-0.flex-1.overflow-y-auto.px-4.py-4
      WorkspaceFilePanel(v-if="open" :mount="mount" :scope-id="scopeId")
</template>
