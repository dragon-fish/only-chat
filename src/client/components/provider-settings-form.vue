<script setup lang="ts">
import { computed } from 'vue'
import ProviderInterfaceList from '@/client/components/provider-interface-list.vue'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import type { CatalogProviderSummary, ProviderWriteInput } from '@/shared/api'

const props = withDefaults(defineProps<{
  modelValue: ProviderWriteInput
  catalogProviders: CatalogProviderSummary[]
  currentCatalogProviderId?: string | null
  hasKey?: boolean
  disabled?: boolean
  idPrefix?: string
}>(), { currentCatalogProviderId: null, hasKey: false, disabled: false, idPrefix: 'provider' })
const emit = defineEmits<{ 'update:modelValue': [value: ProviderWriteInput] }>()

function update(patch: Partial<ProviderWriteInput>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
const association = computed(() => props.modelValue.models_dev_provider?.source === 'manual'
  ? props.modelValue.models_dev_provider.provider_id
  : 'endpoint')
function chooseAssociation(value: unknown) {
  if (typeof value !== 'string') return
  update({ models_dev_provider: value === 'endpoint' ? { source: 'endpoint' } : { source: 'manual', provider_id: value } })
}
</script>

<template lang="pug">
FieldGroup(data-provider-settings-form)
  Field
    FieldLabel(:for="`${idPrefix}-name`") 名称
    Input(:id="`${idPrefix}-name`" :model-value="modelValue.name" required maxlength="100" class="min-h-10" :disabled="disabled" @update:model-value="update({ name: String($event) })")
  Field
    FieldLabel(:for="`${idPrefix}-key`") API Key
    Input(:id="`${idPrefix}-key`" :model-value="modelValue.api_key" type="password" autocomplete="off" placeholder="留空保持不变" class="min-h-10" :disabled="disabled" @update:model-value="update({ api_key: String($event) })")
    FieldDescription {{ hasKey ? '留空保留已配置的密钥。' : '尚未配置密钥。' }}
  Field
    FieldLabel(:for="`${idPrefix}-association`") models.dev 关联
    Select(:model-value="association" :disabled="disabled" @update:model-value="chooseAssociation")
      SelectTrigger(:id="`${idPrefix}-association`" class="w-full")
        SelectValue
      SelectContent
        SelectGroup
          SelectItem(value="endpoint") 按端点自动匹配
          SelectItem(v-for="entry in catalogProviders" :key="entry.id" :value="entry.id") {{ entry.name }}
    FieldDescription {{ modelValue.models_dev_provider?.source === 'manual' ? '手动关联将保留，不受端点修改影响。' : `保存时按默认端点和同源接口匹配。当前关联：${currentCatalogProviderId ?? '未匹配'}` }}
  ProviderInterfaceList(
    :model-value="modelValue.interfaces"
    :default-protocol="modelValue.default_protocol"
    :disabled="disabled"
    @update:model-value="update({ interfaces: $event })"
    @update:default-protocol="update({ default_protocol: $event })")
</template>
