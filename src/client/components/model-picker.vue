<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ChevronDownIcon } from '@lucide/vue'
import ModelPickerContent from '@/client/components/model-picker-content.vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { useConfigStore } from '@/client/stores/config'
import { cn } from '@/client/lib/utils'
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

const open = ref(false)
const isDesktop = useMediaQuery('(min-width: 768px)')
const selected = computed(() => config.modelFor(props.modelValue))
const selectedName = computed(() => selected.value?.model.display_name ?? props.modelValue?.model_id ?? '选择模型')
const selectedProviderName = computed(() => selected.value?.provider.name ?? '模型')
watch(() => props.modelValue, model => {
  void config.ensureModel(model).catch(error => { config.loadError = error instanceof Error ? error.message : String(error) })
}, { immediate: true, deep: true })

function onSelect(value: ModelRef) {
  emit('update:modelValue', value)
  open.value = false
}
</script>

<template lang="pug">
component(:is="isDesktop ? Popover : Drawer" v-model:open="open")
  component(:is="isDesktop ? PopoverTrigger : DrawerTrigger" as-child)
    Button(
      :variant="compact ? 'ghost' : 'outline'" size="sm" :title="`${selectedProviderName} · ${selectedName}`"
      :class="cn('min-h-10 md:min-h-7', compact ? 'min-w-10 px-1' : 'min-w-44 max-w-64 justify-start')"
      :aria-label="`选择模型，当前为 ${selectedName}`")
      ProviderAvatar(:name="selectedProviderName" size="sm")
      span.min-w-0.flex-1.truncate.text-left(v-if="!compact") {{ selectedName }}
      ChevronDownIcon(data-icon="inline-end")
  component(
    :is="isDesktop ? PopoverContent : DrawerContent"
    :align="isDesktop ? 'start' : undefined" :side-offset="isDesktop ? 8 : undefined"
    :class="cn(isDesktop ? 'w-96 max-w-[calc(100vw-1.5rem)] p-0' : 'overflow-hidden pb-[max(1rem,env(safe-area-inset-bottom))]')")
    DrawerHeader(v-if="!isDesktop")
      DrawerTitle 选择模型
      DrawerDescription 搜索模型，或按已声明的能力筛选。
    ModelPickerContent(:model-value="modelValue" @select="onSelect")
</template>
