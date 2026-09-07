<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon } from '@lucide/vue'
import ModelPickerContent from '@/client/components/model-picker-content.vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import type { ModelRef } from '@/shared/api'

const props = withDefaults(defineProps<{
  modelValue: ModelRef | null
  compact?: boolean
}>(), {
  compact: false,
})
const emit = defineEmits<{ 'update:modelValue': [ModelRef | null] }>()
const config = useConfigStore()

const popoverOpen = ref(false)
const drawerOpen = ref(false)
const selected = computed(() => config.modelFor(props.modelValue))
const selectedName = computed(() => selected.value?.model.display_name ?? props.modelValue?.model_id ?? '选择模型')
const selectedProviderName = computed(() => selected.value?.provider.name ?? '模型')

function onSelect(value: ModelRef) {
  emit('update:modelValue', value)
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
    ModelPickerContent(:model-value="modelValue" @select="onSelect")

Drawer(v-else v-model:open="drawerOpen")
  DrawerTrigger(as-child)
    Button(
      variant="ghost" size="sm" :title="`${selectedProviderName} · ${selectedName}`"
      class="min-h-10 min-w-10 px-1" :aria-label="`选择模型，当前为 ${selectedName}`")
      ProviderAvatar(:name="selectedProviderName" size="sm")
      ChevronDownIcon(data-icon="inline-end")
  DrawerContent
    DrawerHeader
      DrawerTitle 选择模型
      DrawerDescription 搜索模型，或按已声明的能力筛选。
    ModelPickerContent(:model-value="modelValue" @select="onSelect")
</template>
