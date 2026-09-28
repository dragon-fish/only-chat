<script setup lang="ts">
import { ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { InfoIcon } from '@lucide/vue'
import { modelName, type EnabledModelEntry } from '@/client/lib/ui-models'
import ModelDetails from './model-details.vue'
import { Button } from '@/client/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/client/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
const props = defineProps<{ entry: EnabledModelEntry }>()
const desktop = useMediaQuery('(min-width: 768px) and (hover: hover)')
const open = ref(false)
</script>

<template>
  <HoverCard :open="desktop && open" :open-delay="250" @update:open="open = desktop && $event">
    <HoverCardTrigger as-child>
      <div class="flex min-w-0 items-center gap-1">
        <div class="min-w-0 flex-1" @focusin="open = desktop" @focusout="open = false"><slot /></div>
        <Popover v-if="!desktop">
          <PopoverTrigger as-child>
            <Button type="button" variant="ghost" size="icon" class="size-10 shrink-0" :aria-label="`查看 ${modelName(entry.model)} 详情`" @keydown.stop><InfoIcon /></Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="end" class="w-80 max-w-[calc(100vw-2rem)] p-4" @click.stop @keydown.stop>
            <ModelDetails :entry="props.entry" />
          </PopoverContent>
        </Popover>
      </div>
    </HoverCardTrigger>
    <HoverCardContent v-if="desktop" side="right" align="start" class="w-80 max-w-[calc(100vw-2rem)] p-4">
      <ModelDetails :entry="props.entry" />
    </HoverCardContent>
  </HoverCard>
</template>
