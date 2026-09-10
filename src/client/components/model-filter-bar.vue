<script setup lang="ts">
import { computed, useId } from 'vue'
import { MODEL_CAPABILITY_FILTERS } from '@/client/lib/ui-models'
import { cn } from '@/client/lib/utils'
import { Button } from '@/client/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { ModelQuery, ProviderWithInterfaces } from '@/shared/models'

const props = withDefaults(defineProps<{
  modelValue: Partial<ModelQuery>
  providers: ProviderWithInterfaces[]
  search?: boolean
  lab?: boolean
  status?: boolean
}>(), { search: true, lab: true, status: false })
const emit = defineEmits<{ 'update:modelValue': [value: Partial<ModelQuery>] }>()
const prefix = useId()
const active = computed(() => MODEL_CAPABILITY_FILTERS.filter(filter => props.modelValue[filter.key] === true).map(filter => filter.key))
const hasFilters = computed(() => Object.entries(props.modelValue).some(([key, value]) => key !== 'search' && value !== undefined && value !== ''))
function update(key: keyof ModelQuery, value: unknown) {
  const query = { ...props.modelValue }
  if (value === undefined || value === '') delete query[key]
  else Object.assign(query, { [key]: value })
  emit('update:modelValue', query)
}
function capabilities(value: unknown) {
  if (!Array.isArray(value)) return
  const query = { ...props.modelValue }
  for (const filter of MODEL_CAPABILITY_FILTERS) {
    if (value.includes(filter.key)) query[filter.key] = true
    else delete query[filter.key]
  }
  emit('update:modelValue', query)
}
</script>

<template lang="pug">
FieldGroup(class="gap-3")
  Field(v-if="search")
    FieldLabel.sr-only(:for="`${prefix}-search`") 搜索模型
    Input(:id="`${prefix}-search`" type="search" :model-value="modelValue.search ?? ''" aria-label="搜索模型" placeholder="搜索模型 ID 或名称…" class="min-h-10" @update:model-value="update('search', String($event))")
  Field
    FieldLabel.sr-only(:id="`${prefix}-capabilities`") 模型能力
    ToggleGroup(type="multiple" size="sm" variant="outline" :spacing="1" :model-value="active" :aria-labelledby="`${prefix}-capabilities`" class="flex-wrap" @update:model-value="capabilities")
      ToggleGroupItem(v-for="filter in MODEL_CAPABILITY_FILTERS" :key="filter.key" :value="filter.key" :aria-label="filter.label" class="min-h-10") {{ filter.label }}
  FieldGroup(class="grid grid-cols-1 gap-3 sm:grid-cols-2")
    Field(v-if="status")
      FieldLabel(:for="`${prefix}-status`") 状态
      Select(:model-value="modelValue.enabled === undefined ? 'all' : String(modelValue.enabled)" @update:model-value="update('enabled', $event === 'all' ? undefined : $event === 'true')")
        SelectTrigger(:id="`${prefix}-status`" class="min-h-10 w-full")
          SelectValue(placeholder="全部状态")
        SelectContent
          SelectGroup
            SelectItem(value="all") 全部状态
            SelectItem(value="true") 已启用
            SelectItem(value="false") 已禁用
    Field(v-if="lab")
      FieldLabel(:for="`${prefix}-lab`") Lab
      Input(:id="`${prefix}-lab`" :model-value="modelValue.lab_id ?? ''" placeholder="全部（或输入 Lab ID）" class="min-h-10" @update:model-value="update('lab_id', String($event).trim())")
    Field
      FieldLabel(:for="`${prefix}-context`") 最小上下文
      Input(:id="`${prefix}-context`" type="number" min="0" step="1" :model-value="modelValue.min_context ?? ''" placeholder="不限" class="min-h-10" @update:model-value="update('min_context', $event === '' ? undefined : Number($event))")
    Field(:class="cn(lab && 'sm:col-span-2')")
      FieldLabel(:for="`${prefix}-interface`") 接口
      Select(:model-value="String(modelValue.interface_id ?? 'all')" @update:model-value="update('interface_id', $event === 'all' ? undefined : Number($event))")
        SelectTrigger(:id="`${prefix}-interface`" class="min-h-10 w-full")
          SelectValue(placeholder="全部接口")
        SelectContent
          SelectGroup
            SelectItem(value="all") 全部接口
          SelectGroup(v-for="provider in providers" :key="provider.id")
            SelectItem(v-for="endpoint in provider.interfaces" :key="endpoint.id" :value="String(endpoint.id)") {{ provider.name }} · {{ endpoint.protocol }}
  Button(v-if="hasFilters" type="button" variant="ghost" size="sm" class="min-h-10 self-start" @click="emit('update:modelValue', {})") 清除筛选
</template>
