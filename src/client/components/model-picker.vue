<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { ChevronDownIcon } from '@lucide/vue'
import ModelPickerContent from '@/client/components/model-picker-content.vue'
import ProviderQuickSettingsDialog from '@/client/components/provider-quick-settings-dialog.vue'
import LabAvatar from '@/client/components/lab-avatar.vue'
import ProviderSuffix from '@/client/components/provider-suffix.vue'
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
const quickSettingsOpen = ref(false)
const quickSettingsProviderId = ref<number | null>(null)
const isDesktop = useMediaQuery('(min-width: 768px)')
const selected = computed(() => config.modelFor(props.modelValue))
const selectedName = computed(() => selected.value?.model.metadata.name ?? props.modelValue?.model_id ?? '选择模型')
const selectedProviderName = computed(() => selected.value?.provider.name ?? '模型')
const selectedError = ref<string | null>(null)
let selectedRequest = 0
watch(() => props.modelValue, async model => {
  const request = ++selectedRequest
  selectedError.value = null
  try { await config.ensureModel(model) }
  catch (error) {
    if (request === selectedRequest) selectedError.value = error instanceof Error ? error.message : String(error)
  }
}, { immediate: true, deep: true })

function onSelect(value: ModelRef) {
  emit('update:modelValue', value)
  open.value = false
}
function editProvider(providerId: number) {
  open.value = false
  quickSettingsProviderId.value = providerId
  quickSettingsOpen.value = true
}
</script>

<template lang="pug">
component(:is="isDesktop ? Popover : Drawer" v-model:open="open")
  component(:is="isDesktop ? PopoverTrigger : DrawerTrigger" as-child)
    Button(
      :variant="compact ? 'ghost' : 'outline'" size="sm" :title="`${selectedProviderName} · ${selectedName}`"
      :class="cn('min-h-10 md:min-h-7', compact ? 'min-w-10 px-1' : 'min-w-44 max-w-64 justify-start')"
      :aria-label="`选择模型，当前为 ${selectedName}`")
      LabAvatar(:model-id="selected?.model.model_id" :lab-id="selected?.model.lab_id ?? null" :family="selected?.model.metadata.family" :provider-name="selectedProviderName" size="sm")
      span.flex.min-w-0.flex-1.items-baseline.gap-1.overflow-hidden.text-left(v-if="!compact")
        span(class="max-w-full shrink-0 truncate") {{ selectedName }}
        ProviderSuffix(v-if="selected" :name="selected.provider.name")
      ChevronDownIcon(data-icon="inline-end")
  component(
    :is="isDesktop ? PopoverContent : DrawerContent"
    :align="isDesktop ? 'start' : undefined" :side-offset="isDesktop ? 8 : undefined"
    :class="cn(isDesktop ? 'w-[24rem] max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto p-0' : 'overflow-y-auto pb-[max(1rem,env(safe-area-inset-bottom))]')")
    DrawerHeader(v-if="!isDesktop")
      DrawerTitle 选择模型
      DrawerDescription 搜索模型，或按已声明的能力筛选。
    p.px-3.py-2.text-sm.text-muted-foreground(v-if="selectedError" role="status") 当前选择的模型无法加载：{{ selectedError }}
    ModelPickerContent(:model-value="modelValue" @select="onSelect" @edit-provider="editProvider")
ProviderQuickSettingsDialog(v-model:open="quickSettingsOpen" :provider-id="quickSettingsProviderId")
</template>
