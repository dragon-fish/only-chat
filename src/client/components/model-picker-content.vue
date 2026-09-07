<script setup lang="ts">
import { computed, ref } from 'vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { filterModelEntries, type EnabledModelEntry, type ModelCapabilityFilter } from '@/client/lib/ui-models'
import { useConfigStore } from '@/client/stores/config'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { ModelRef } from '@/shared/api'
import type { Provider } from '@/shared/models'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ select: [ModelRef] }>()
const config = useConfigStore()

const query = ref('')
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
Command(:model-value="currentKey" class="min-h-0" @update:model-value="onSelect")
  CommandInput(placeholder="搜索提供商或模型…" @input="onSearch")
  .px-3.py-2
    ToggleGroup(
      type="single" size="sm" variant="outline" :model-value="capability"
      aria-label="按模型能力筛选" @update:model-value="onCapability")
      ToggleGroupItem(
        v-for="option in CAPABILITY_FILTERS" :key="option.value" :value="option.value"
        :aria-label="option.label" class="min-h-10 min-w-10 md:min-h-7 md:min-w-0") {{ option.label }}
  CommandList(class="max-h-[min(20rem,55vh)]")
    CommandEmpty 无匹配模型
    Empty(v-if="entries.length === 0 && !query")
      EmptyHeader
        EmptyTitle 没有可用模型
        EmptyDescription 当前筛选条件下没有已启用的模型。
    CommandGroup(v-for="group in groups" :key="group.provider.id" :heading="group.provider.name")
      CommandItem(
        v-for="entry in group.entries" :key="keyFor(entry)" :value="keyFor(entry)"
        class="min-h-10 md:min-h-0")
        ProviderAvatar(:name="entry.provider.name" size="sm")
        .min-w-0.flex-1
          p.truncate {{ entry.model.display_name }}
          p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
        span.sr-only {{ entry.provider.name }}
</template>
