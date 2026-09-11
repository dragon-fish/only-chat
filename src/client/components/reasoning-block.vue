<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { BrainIcon, ChevronRightIcon } from '@lucide/vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'

const props = defineProps<{
  text: string
  /** The live tail of a streaming reply. Open while it is, collapsed the moment anything follows. */
  active: boolean
}>()

// Follows `active` until the reader touches it; after that their choice wins for this block.
const overridden = ref(false)
const open = ref(props.active)
watch(() => props.active, value => { if (!overridden.value) open.value = value })

function setOpen(value: boolean) {
  overridden.value = true
  open.value = value
}

const preview = computed(() => props.text.replace(/\s+/g, ' ').trim())
</script>

<template lang="pug">
Collapsible(:open="open" @update:open="setOpen")
  CollapsibleTrigger(
    class="group flex w-full items-center gap-2 rounded-md py-1 text-xs text-muted-foreground hover:text-foreground")
    BrainIcon(class="size-3.5 shrink-0")
    span.shrink-0 {{ active ? '正在思考…' : '思考过程' }}
    //- The one-line peek is what makes a collapsed block worth leaving collapsed.
    span(v-if="!open" class="min-w-0 flex-1 truncate text-left opacity-60") {{ preview }}
    ChevronRightIcon(class="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90")
  CollapsibleContent
    .oc-scroll.mt-1.max-h-80.overflow-y-auto.border-l.pl-3(class="text-xs leading-relaxed text-muted-foreground")
      p.whitespace-pre-wrap {{ text }}
</template>
