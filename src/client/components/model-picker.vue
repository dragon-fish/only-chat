<script setup lang="ts">
import { computed } from 'vue'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import type { ModelRef } from '@/shared/api'

const props = defineProps<{ modelValue: ModelRef | null }>()
const emit = defineEmits<{ 'update:modelValue': [ModelRef | null] }>()
const config = useConfigStore()

const options = computed(() => config.enabledModels().map(({ provider, model }) => ({
  key: `${provider.id}:${model.model_id}`, label: `${provider.name} · ${model.display_name}`, ref: { provider_id: provider.id, model_id: model.model_id },
})))
const current = computed(() => props.modelValue ? `${props.modelValue.provider_id}:${props.modelValue.model_id}` : '')

// reka-ui emits `AcceptableValue`; narrow here rather than in the template.
function onChange(key: unknown) {
  emit('update:modelValue', options.value.find((o) => o.key === key)?.ref ?? null)
}
</script>

<template lang="pug">
Select(:model-value="current" @update:model-value="onChange")
  SelectTrigger(class="h-8 w-56 text-xs")
    SelectValue(placeholder="选择模型")
  SelectContent
    SelectItem(v-for="o in options" :key="o.key" :value="o.key") {{ o.label }}
</template>
