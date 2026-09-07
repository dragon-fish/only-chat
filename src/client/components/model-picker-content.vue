<script setup lang="ts">
import { computed, ref } from 'vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import CollectionState from '@/client/components/collection-state.vue'
import { Button } from '@/client/ui/button'
import { Badge } from '@/client/ui/badge'
import { RouterLink } from 'vue-router'
import { filterModelEntries, type EnabledModelEntry, type ModelCapabilityFilter } from '@/client/lib/ui-models'
import { useConfigStore } from '@/client/stores/config'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { ModelRef } from '@/shared/api'
import type { Provider } from '@/shared/models'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ select: [ModelRef] }>()
const config = useConfigStore()

const query = ref('')
const searchKey = ref(0)
const capability = ref<ModelCapabilityFilter>('all')

const CAPABILITY_FILTERS: ReadonlyArray<{ value: ModelCapabilityFilter, label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'vision', label: '视觉' },
  { value: 'reasoning', label: '推理' },
  { value: 'tools', label: '工具' },
  { value: 'image_output', label: '生图' },
]

const entries = computed(() => filterModelEntries(config.enabledModels(), query.value, capability.value))
const groups = computed(() => {
  const byProvider = new Map<number, { provider: Provider, entries: EnabledModelEntry[] }>()
  for (const entry of entries.value) {
    const group = byProvider.get(entry.provider.id)
    if (group) group.entries.push(entry)
    else byProvider.set(entry.provider.id, { provider: entry.provider, entries: [entry] })
  }
  return [...byProvider.values()]
})
const currentKey = computed(() => props.modelValue
  ? `${props.modelValue.provider_id}:${props.modelValue.model_id}`
  : '')

function keyFor(entry: EnabledModelEntry) {
  return `${entry.provider.id}:${entry.model.model_id}`
}

function onSearch(event: Event) {
  query.value = (event.target as HTMLInputElement).value
}

function clearFilters() {
  query.value = ''
  capability.value = 'all'
  searchKey.value++
}

function onCapability(value: unknown) {
  const next = CAPABILITY_FILTERS.find(option => option.value === value)?.value
  capability.value = next ?? 'all'
}

// reka-ui emits `AcceptableValue`; narrow it against enabled models before exposing a ModelRef.
function onSelect(value: unknown) {
  const entry = config.enabledModels().find(candidate => keyFor(candidate) === value)
  if (!entry) return
  emit('select', { provider_id: entry.provider.id, model_id: entry.model.model_id })
  query.value = ''
}
</script>

<template lang="pug">
Command(:key="searchKey" :model-value="currentKey" :should-filter="false" class="min-h-0" @update:model-value="onSelect")
  CommandInput(placeholder="搜索提供商或模型…" @input="onSearch")
  .px-3.py-2
    ToggleGroup(
      type="single" size="sm" variant="outline" :model-value="capability"
      aria-label="按模型能力筛选" @update:model-value="onCapability")
      ToggleGroupItem(
        v-for="option in CAPABILITY_FILTERS" :key="option.value" :value="option.value"
        :aria-label="option.label" class="min-h-10 min-w-10 md:min-h-7 md:min-w-0") {{ option.label }}
  CommandList(class="max-h-[min(20rem,55vh)]")
    CollectionState(:loaded="config.loaded" :error="config.loadError" :retry="config.load" :empty="entries.length === 0" empty-title="没有可用模型" empty-description="当前筛选条件下没有已启用的模型。")
      template(#empty-action)
        Button(v-if="query || capability !== 'all'" variant="outline" class="min-h-10" @click="clearFilters") 清除筛选
        Button(v-else as-child variant="outline" class="min-h-10")
          RouterLink(to="/settings/providers") 配置模型
      CommandGroup(v-for="group in groups" :key="group.provider.id" :heading="group.provider.name")
        CommandItem(
          v-for="entry in group.entries" :key="keyFor(entry)" :value="keyFor(entry)"
          class="min-h-10 md:min-h-0")
          ProviderAvatar(:name="entry.provider.name" size="sm")
          .min-w-0.flex-1
            p.truncate {{ entry.model.display_name }}
            p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
            .mt-1.flex.flex-wrap.gap-1
              template(v-for="filter in CAPABILITY_FILTERS" :key="filter.value")
                Badge(v-if="filter.value !== 'all' && entry.model.capabilities[filter.value] === true" variant="secondary") {{ filter.label }}
          span.sr-only {{ entry.provider.name }}
</template>
