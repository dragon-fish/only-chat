<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Settings, X } from '@lucide/vue'
import ProjectTree from '@/client/components/project-tree.vue'
import { useSyncStore } from '@/client/stores/sync'

/**
 * The sidebar renders identically on both breakpoints, but only the Sheet copy has something to
 * close; the desktop aside is always on screen and gets no 关闭 button (spec §7.1).
 */
withDefaults(defineProps<{ closable?: boolean }>(), { closable: false })
const emit = defineEmits<{ navigate: []; close: [] }>()

const sync = useSyncStore()
</script>

<template lang="pug">
//- Spec §8: the header stays put and `ProjectTree`'s root is this region's only scroll owner.
.flex.h-full.min-h-0.flex-col.overflow-hidden
  .flex.shrink-0.items-center.gap-2.px-4.pt-3
    span.text-sm.font-semibold only-chat
    span.ml-auto.size-2.rounded-full(:class="sync.status === 'open' ? 'bg-emerald-500' : 'bg-zinc-400'" :title="sync.status")
  //- Spec §7.1: 设置 and 关闭 sit next to each other in normal flow, so neither can cover the
  //- other; both are 40×40 CSS px, which is the touch floor this header has to clear.
  .flex.shrink-0.items-center.gap-1.p-2
    RouterLink.min-w-0.flex-1.rounded-md.px-2.text-sm(
      to="/" class="inline-flex min-h-10 items-center hover:bg-accent" @click="emit('navigate')") 新对话
    RouterLink.shrink-0.rounded-md.text-muted-foreground(
      to="/settings/providers" title="设置" aria-label="设置"
      class="inline-flex size-10 items-center justify-center hover:bg-accent hover:text-foreground"
      @click="emit('navigate')")
      Settings(class="size-4")
    button.shrink-0.rounded-md.text-muted-foreground(
      v-if="closable" type="button" title="关闭侧栏" aria-label="关闭侧栏"
      class="inline-flex size-10 items-center justify-center hover:bg-accent hover:text-foreground"
      @click="emit('close')")
      X(class="size-4")
  ProjectTree(@navigate="emit('navigate')")
</template>
