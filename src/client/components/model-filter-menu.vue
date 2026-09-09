<script setup lang="ts">
import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { SlidersHorizontalIcon, XIcon } from '@lucide/vue'
import ModelFilterBar from '@/client/components/model-filter-bar.vue'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Input } from '@/client/ui/input'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@/client/ui/popover'
import type { ModelQuery, ProviderWithInterfaces } from '@/shared/models'

const props = withDefaults(defineProps<{
  modelValue: Partial<ModelQuery>
  providers: ProviderWithInterfaces[]
  search?: boolean
  lab?: boolean
  status?: boolean
  chips?: boolean
}>(), { search: true, lab: true, status: false, chips: true })
const emit = defineEmits<{ 'update:modelValue': [value: Partial<ModelQuery>] }>()
const isDesktop = useMediaQuery('(min-width: 768px)')
const filterKeys = ['vision', 'reasoning', 'tools', 'image_output', 'enabled', 'lab_id', 'min_context', 'interface_id'] as const
const activeFilters = computed(() => filterKeys.filter(key => props.modelValue[key] !== undefined && props.modelValue[key] !== ''))
const labels: Record<typeof filterKeys[number], string> = {
  vision: '视觉', reasoning: '推理', tools: '工具', image_output: '图片输出', enabled: '状态',
  lab_id: 'Lab', min_context: '上下文', interface_id: '接口',
}
function updateSearch(value: string | number) {
  const search = String(value)
  emit('update:modelValue', { ...props.modelValue, search: search || undefined })
}
function updateFilters(value: Partial<ModelQuery>) {
  emit('update:modelValue', { ...(props.modelValue.search ? { search: props.modelValue.search } : {}), ...value })
}
function remove(key: typeof filterKeys[number]) {
  const value = { ...props.modelValue }
  delete value[key]
  emit('update:modelValue', value)
}
</script>

<template lang="pug">
.flex.flex-col.gap-2
  .flex.items-center.gap-2
    Input(
      v-if="search" type="search" :model-value="modelValue.search ?? ''"
      aria-label="搜索模型" placeholder="搜索模型 ID 或名称…" class="min-h-10 min-w-0 flex-1"
      @update:model-value="updateSearch")
    component(:is="isDesktop ? Popover : Drawer")
      component(:is="isDesktop ? PopoverTrigger : DrawerTrigger" as-child)
        Button(type="button" variant="outline" size="icon" class="relative size-10" aria-label="筛选模型")
          SlidersHorizontalIcon
          Badge(
            v-if="activeFilters.length" variant="default"
            class="absolute -right-1.5 -top-1.5 min-w-4 px-1 text-[0.625rem]") {{ activeFilters.length }}
      component(
        :is="isDesktop ? PopoverContent : DrawerContent"
        :align="isDesktop ? 'end' : undefined"
        :class="isDesktop ? 'w-80' : 'max-h-[80dvh] overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]'")
        component(:is="isDesktop ? PopoverHeader : DrawerHeader")
          component(:is="isDesktop ? PopoverTitle : DrawerTitle") 筛选模型
          component(:is="isDesktop ? PopoverDescription : DrawerDescription") 只显示符合全部条件的模型。
        .p-4.pt-0(v-if="!isDesktop")
          ModelFilterBar(:model-value="modelValue" :providers="providers" :search="false" :lab="lab" :status="status" @update:model-value="updateFilters")
        ModelFilterBar(v-else :model-value="modelValue" :providers="providers" :search="false" :lab="lab" :status="status" @update:model-value="updateFilters")
  .flex.flex-wrap.gap-1(v-if="chips && activeFilters.length")
    Button(v-for="key in activeFilters" :key="key" type="button" variant="secondary" size="xs" @click="remove(key)")
      | {{ labels[key] }}
      XIcon(data-icon="inline-end")
</template>
