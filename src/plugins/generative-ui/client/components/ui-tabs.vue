<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { isElement, RenderValue, type NodeProps } from '../runtime'

interface TabItemProps { value: string, trigger: string, content?: unknown[] }
const { props, renderNode } = defineProps<NodeProps<{ items?: unknown[] }>>()
const items = computed(() => (props.items ?? []).filter(item => isElement<TabItemProps>(item)).map(item => item.props))
const active = ref(items.value[0]?.value ?? '')
watch(items, (next) => {
  if (!next.some(item => item.value === active.value)) active.value = next[0]?.value ?? ''
})
</script>

<template lang="pug">
Tabs.min-w-0(v-model="active")
  //- Scrolls instead of squeezing: five product names will not fit a phone side by side.
  .max-w-full.overflow-x-auto(class="[scrollbar-width:none]")
    TabsList
      TabsTrigger(v-for="item in items" :key="item.value" :value="item.value" class="min-h-9 md:min-h-0") {{ item.trigger }}
  TabsContent.flex.min-w-0.flex-col.gap-3(v-for="item in items" :key="item.value" :value="item.value" class="pt-2")
    RenderValue(
      v-for="(child, index) in (item.content ?? []).filter(child => child != null)" :key="index"
      :value="child" :render="renderNode")
</template>
