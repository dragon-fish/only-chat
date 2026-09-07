<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon } from '@lucide/vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { filterModelEntries, type EnabledModelEntry, type ModelCapabilityFilter } from '@/client/lib/ui-models'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { ModelRef } from '@/shared/api'
import type { Provider } from '@/shared/models'

const props = withDefaults(defineProps<{
  modelValue: ModelRef | null
  compact?: boolean
}>(), {
  compact: false,
})
const emit = defineEmits<{ 'update:modelValue': [ModelRef | null] }>()
const config = useConfigStore()

const query = ref('')
const capability = ref<ModelCapabilityFilter>('all')
const popoverOpen = ref(false)
const drawerOpen = ref(false)

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

const selected = computed(() => config.modelFor(props.modelValue))
const currentKey = computed(() => props.modelValue
  ? `${props.modelValue.provider_id}:${props.modelValue.model_id}`
  : '')
const selectedName = computed(() => selected.value?.model.display_name ?? props.modelValue?.model_id ?? '选择模型')
const selectedProviderName = computed(() => selected.value?.provider.name ?? '模型')

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
  emit('update:modelValue', { provider_id: entry.provider.id, model_id: entry.model.model_id })
  query.value = ''
  popoverOpen.value = false
  drawerOpen.value = false
}
</script>

<template lang="pug">
Popover(v-if="!compact" v-model:open="popoverOpen")
  PopoverTrigger(as-child)
    Button(
      variant="outline" size="sm" :title="`${selectedProviderName} · ${selectedName}`"
      class="min-w-44 max-w-64 justify-start" aria-label="选择模型")
      ProviderAvatar(:name="selectedProviderName" size="sm")
      span.min-w-0.flex-1.truncate.text-left {{ selectedName }}
      ChevronDownIcon(data-icon="inline-end")
  PopoverContent(align="start" :side-offset="8" class="w-96 max-w-[calc(100vw-1.5rem)] p-0")
    Command(:model-value="currentKey" @update:model-value="onSelect")
      CommandInput(placeholder="搜索提供商或模型…" @input="onSearch")
      .px-2.py-2
        ToggleGroup(
          type="single" size="sm" variant="outline" :model-value="capability"
          aria-label="按模型能力筛选" @update:model-value="onCapability")
          ToggleGroupItem(
            v-for="option in CAPABILITY_FILTERS" :key="option.value" :value="option.value"
            :aria-label="option.label") {{ option.label }}
      CommandList(class="max-h-80")
        CommandEmpty 无匹配模型
        Empty(v-if="entries.length === 0 && !query")
          EmptyHeader
            EmptyTitle 没有可用模型
            EmptyDescription 当前筛选条件下没有已启用的模型。
        CommandGroup(v-for="group in groups" :key="group.provider.id" :heading="group.provider.name")
          CommandItem(v-for="entry in group.entries" :key="keyFor(entry)" :value="keyFor(entry)")
            ProviderAvatar(:name="entry.provider.name" size="sm")
            .min-w-0.flex-1
              p.truncate {{ entry.model.display_name }}
              p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
            span.sr-only {{ entry.provider.name }}

Drawer(v-else v-model:open="drawerOpen")
  DrawerTrigger(as-child)
    Button(
      variant="ghost" size="sm" :title="`${selectedProviderName} · ${selectedName}`"
      class="px-1" :aria-label="`选择模型，当前为 ${selectedName}`")
      ProviderAvatar(:name="selectedProviderName" size="sm")
      ChevronDownIcon(data-icon="inline-end")
  DrawerContent
    DrawerHeader
      DrawerTitle 选择模型
      DrawerDescription 搜索模型，或按已声明的能力筛选。
    Command(:model-value="currentKey" class="min-h-0" @update:model-value="onSelect")
      CommandInput(placeholder="搜索提供商或模型…" @input="onSearch")
      .px-3.py-2
        ToggleGroup(
          type="single" size="sm" variant="outline" :model-value="capability"
          aria-label="按模型能力筛选" @update:model-value="onCapability")
          ToggleGroupItem(
            v-for="option in CAPABILITY_FILTERS" :key="option.value" :value="option.value"
            :aria-label="option.label") {{ option.label }}
      CommandList(class="max-h-[55vh]")
        CommandEmpty 无匹配模型
        Empty(v-if="entries.length === 0 && !query")
          EmptyHeader
            EmptyTitle 没有可用模型
            EmptyDescription 当前筛选条件下没有已启用的模型。
        CommandGroup(v-for="group in groups" :key="group.provider.id" :heading="group.provider.name")
          CommandItem(v-for="entry in group.entries" :key="keyFor(entry)" :value="keyFor(entry)")
            ProviderAvatar(:name="entry.provider.name" size="sm")
            .min-w-0.flex-1
              p.truncate {{ entry.model.display_name }}
              p.truncate.text-xs.text-muted-foreground {{ entry.model.model_id }}
            span.sr-only {{ entry.provider.name }}
</template>
