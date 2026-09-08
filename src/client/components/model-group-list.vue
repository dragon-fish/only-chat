<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDownIcon } from '@lucide/vue'
import { groupModelEntries, labName, type EnabledModelEntry, type ModelLabGroup } from '@/client/lib/ui-models'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { CommandGroup } from '@/client/ui/command'
import type { CatalogProviderSummary } from '@/shared/api'

const props = withDefaults(defineProps<{
  entries: EnabledModelEntry[]
  catalogProviders?: CatalogProviderSummary[]
  command?: boolean
  showProviders?: boolean
  collapsible?: boolean
  showSingleLab?: boolean
  showLabs?: boolean
  stickyProviders?: boolean
}>(), {
  catalogProviders: () => [], command: false, showProviders: true, collapsible: false,
  showSingleLab: false, showLabs: true, stickyProviders: false,
})
const groups = computed(() => groupModelEntries(props.entries, props.catalogProviders))
function heading(lab: ModelLabGroup) { return lab.heading ?? (lab.id === null ? '其他' : labName(lab.id, props.catalogProviders)) }
function groupEntries(group: typeof groups.value[number]) { return group.labs.flatMap(lab => lab.entries) }
</script>

<template lang="pug">
component(
  v-for="group in groups" :is="command ? CommandGroup : 'section'" :key="group.provider.id"
  :class="cn('flex flex-col gap-2', command && stickyProviders && 'overflow-visible')")
  .flex.min-h-8.items-center.gap-1.px-2.text-xs.font-medium.text-muted-foreground(
    v-if="command && showProviders" data-model-provider-heading
    :class="cn(stickyProviders && 'sticky top-0 z-10 border-b bg-popover/95 backdrop-blur-sm')")
    span.min-w-0.flex-1.truncate {{ group.provider.name }}
    slot(name="provider-actions" :provider="group.provider")
  .flex.min-h-8.items-center.gap-1(v-else-if="showProviders")
    h3.min-w-0.flex-1.truncate.text-sm.font-medium {{ group.provider.name }}
    slot(name="provider-actions" :provider="group.provider")
  template(v-if="!showLabs")
    slot(v-for="entry in groupEntries(group)" :key="entry.model.id" :entry="entry")
  template(v-else-if="command || !collapsible")
    template(v-for="lab in group.labs" :key="lab.id ?? '__other__'")
      h4(v-if="lab.heading" class="px-2 pt-2 text-xs font-medium text-muted-foreground" data-model-lab-heading) {{ lab.heading }}
      slot(v-for="entry in lab.entries" :key="entry.model.id" :entry="entry")
  template(v-else)
    template(v-for="lab in group.labs" :key="lab.id ?? '__other__'")
      Collapsible(default-open class="rounded-xl border" data-model-lab-group)
        .flex.min-h-11.items-center.gap-1.px-1
          CollapsibleTrigger(as-child)
            Button(type="button" variant="ghost" class="group/trigger min-h-10 min-w-0 flex-1 justify-start")
              ChevronDownIcon(class="transition-transform group-data-[state=open]/trigger:rotate-180")
              span.truncate {{ heading(lab) }}
              span.text-muted-foreground {{ lab.entries.filter(entry => entry.model.enabled).length }}/{{ lab.entries.length }}
          slot(name="lab-actions" :provider="group.provider" :lab="lab")
        CollapsibleContent
          .flex.flex-col.gap-2.p-2.pt-0
            slot(v-for="entry in lab.entries" :key="entry.model.id" :entry="entry")
</template>
