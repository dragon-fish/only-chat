<script setup lang="ts">
import { computed } from 'vue'
import { groupModelEntries, type EnabledModelEntry } from '@/client/lib/ui-models'
import { CommandGroup } from '@/client/ui/command'
import type { CatalogProviderSummary } from '@/shared/api'

const props = withDefaults(defineProps<{ entries: EnabledModelEntry[]; catalogProviders?: CatalogProviderSummary[]; command?: boolean; showProviders?: boolean }>(), { catalogProviders: () => [], command: false, showProviders: true })
const groups = computed(() => groupModelEntries(props.entries, props.catalogProviders))
</script>

<template lang="pug">
component(v-for="group in groups" :is="command ? CommandGroup : 'section'" :key="group.provider.id" :heading="command && showProviders ? group.provider.name : undefined" class="flex flex-col gap-2")
  h3(v-if="!command && showProviders" class="text-sm font-medium") {{ group.provider.name }}
  template(v-for="lab in group.labs" :key="lab.id ?? '__other__'")
    h4(v-if="lab.heading" class="px-2 pt-2 text-xs font-medium text-muted-foreground" data-model-lab-heading) {{ lab.heading }}
    slot(v-for="entry in lab.entries" :key="entry.model.id" :entry="entry")
</template>
