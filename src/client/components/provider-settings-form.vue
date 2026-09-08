<script setup lang="ts">
import { computed, ref } from 'vue'
import { Settings2Icon } from '@lucide/vue'
import ProviderRequestConfig from '@/client/components/provider-request-config.vue'
import { Button } from '@/client/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
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
const requestOpen = ref(false)

function update(patch: Partial<ProviderWriteInput>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
const defaultEndpoint = computed(() => props.modelValue.interfaces.find(endpoint => endpoint.protocol === props.modelValue.default_protocol))
function updateDefaultUrl(value: string | number) {
  update({ interfaces: props.modelValue.interfaces.map(endpoint => endpoint.protocol === props.modelValue.default_protocol ? { ...endpoint, base_url: String(value) } : endpoint) })
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
    FieldLabel(:for="`${idPrefix}-default-url`") 默认 API 地址
    Input(:id="`${idPrefix}-default-url`" data-provider-default-url :model-value="defaultEndpoint?.base_url ?? ''" type="url" required class="min-h-10" :disabled="disabled || !defaultEndpoint" @update:model-value="updateDefaultUrl")
    FieldDescription {{ defaultEndpoint ? `${defaultEndpoint.protocol} · 其他协议可在请求配置中管理。` : '请先添加一个接口。' }}
  .flex.flex-wrap.gap-2
    Button(type="button" variant="ghost" class="min-h-10" :disabled="disabled" @click="requestOpen = true") 添加端点
    Button(type="button" variant="outline" class="min-h-10" :disabled="disabled" @click="requestOpen = true")
      Settings2Icon(data-icon="inline-start")
      | 请求配置
ProviderRequestConfig(
  v-model:open="requestOpen"
  :model-value="modelValue"
  :catalog-providers="catalogProviders"
  :current-catalog-provider-id="currentCatalogProviderId"
  @apply="emit('update:modelValue', $event)")
</template>
