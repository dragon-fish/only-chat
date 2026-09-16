<script setup lang="ts">
import { ref } from 'vue'
import { PlusIcon, Settings2Icon } from '@lucide/vue'
import ProviderRequestConfig from '@/client/components/provider-request-config.vue'
import { Button } from '@/client/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { RadioGroup, RadioGroupItem } from '@/client/ui/radio-group'
import type { CatalogProviderSummary, ProviderWriteInput } from '@/shared/api'
import { InterfaceProtocolSchema, type InterfaceProtocol } from '@/shared/models'

const props = withDefaults(defineProps<{
  modelValue: ProviderWriteInput
  catalogProviders: CatalogProviderSummary[]
  currentCatalogProviderId?: string | null
  hasKey?: boolean
  disabled?: boolean
  idPrefix?: string
  persist: (value: ProviderWriteInput) => Promise<boolean>
}>(), { currentCatalogProviderId: null, hasKey: false, disabled: false, idPrefix: 'provider' })
const emit = defineEmits<{
  'update:modelValue': [value: ProviderWriteInput]
}>()
const requestOpen = ref(false)
const protocolLabels: Record<InterfaceProtocol, string> = {
  responses: 'OpenAI Responses',
  'chat-completions': 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  'vertex-compatible': 'Vertex 兼容',
}

function update(patch: Partial<ProviderWriteInput>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
function chooseDefault(value: unknown) {
  const parsed = InterfaceProtocolSchema.safeParse(value)
  if (parsed.success) update({ default_protocol: parsed.data })
}
async function persistRequestConfig(value: ProviderWriteInput) {
  emit('update:modelValue', value)
  return props.persist(value)
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
    FieldLabel API 地址
    RadioGroup(
      v-if="modelValue.interfaces.length"
      data-api-endpoints
      :model-value="modelValue.default_protocol"
      :disabled="disabled"
      class="grid-cols-1 sm:grid-cols-2"
      @update:model-value="chooseDefault")
      FieldLabel(
        v-for="endpoint in modelValue.interfaces"
        :key="endpoint.protocol"
        :for="`${idPrefix}-endpoint-${endpoint.protocol}`"
        data-api-endpoint-choice
        class="w-full min-w-0 cursor-pointer items-center overflow-hidden rounded-xl border p-3 transition-colors has-data-checked:border-primary has-data-checked:bg-primary/5")
        RadioGroupItem(
          :id="`${idPrefix}-endpoint-${endpoint.protocol}`"
          :value="endpoint.protocol"
          :aria-label="`设为默认 ${protocolLabels[endpoint.protocol]}`")
        FieldContent(class="min-w-0")
          FieldTitle(class="truncate") {{ protocolLabels[endpoint.protocol] }}
          FieldDescription(class="truncate" :title="endpoint.base_url") {{ endpoint.base_url }}
    Button(v-else type="button" variant="outline" class="h-auto min-h-20 w-full justify-start border-dashed" :disabled="disabled" @click="requestOpen = true")
      PlusIcon(data-icon="inline-start")
      | 添加 API 地址
    FieldDescription(v-if="modelValue.interfaces.length") 选择聊天模型默认使用的协议；地址与 Files 能力在配置页管理。
  Button(v-if="modelValue.interfaces.length" type="button" variant="outline" class="min-h-10 self-start" :disabled="disabled" @click="requestOpen = true")
    Settings2Icon(data-icon="inline-start")
    | API 地址配置
ProviderRequestConfig(
  v-model:open="requestOpen"
  :model-value="modelValue"
  :catalog-providers="catalogProviders"
  :current-catalog-provider-id="currentCatalogProviderId"
  :persist="persistRequestConfig")
</template>
