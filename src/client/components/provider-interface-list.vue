<script setup lang="ts">
import { computed, useId } from 'vue'
import { Trash2Icon } from '@lucide/vue'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Button } from '@/client/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Switch } from '@/client/ui/switch'
import { InterfaceProtocolSchema, type InterfaceProtocol } from '@/shared/models'
import type { ProviderInterfaceInput } from '@/shared/api'

const props = defineProps<{ modelValue: ProviderInterfaceInput[]; defaultProtocol?: InterfaceProtocol; initialBaseUrl?: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [ProviderInterfaceInput[]]; 'update:defaultProtocol': [InterfaceProtocol] }>()
const prefix = useId()
const labels: Record<InterfaceProtocol, string> = {
  responses: 'OpenAI Responses', 'chat-completions': 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', 'vertex-compatible': 'Vertex 兼容',
}
const available = computed(() => InterfaceProtocolSchema.options.filter(protocol => !props.modelValue.some(endpoint => endpoint.protocol === protocol)))
function update(protocol: InterfaceProtocol, patch: { base_url?: string; native_files?: boolean }) {
  emit('update:modelValue', props.modelValue.map(endpoint => {
    if (endpoint.protocol !== protocol) return endpoint
    const next = { ...endpoint, ...patch }
    return next.protocol === 'vertex-compatible' ? { ...next, native_files: false as const } : next
  }))
}
function add(value: unknown) {
  const parsed = InterfaceProtocolSchema.safeParse(value)
  if (!parsed.success || !available.value.includes(parsed.data)) return
  emit('update:modelValue', [...props.modelValue, { protocol: parsed.data, base_url: props.modelValue.length ? '' : props.initialBaseUrl ?? '', native_files: false }])
  if (!props.modelValue.length) emit('update:defaultProtocol', parsed.data)
}
function remove(protocol: InterfaceProtocol) {
  if (props.modelValue.length <= 1) return
  const next = props.modelValue.filter(endpoint => endpoint.protocol !== protocol)
  emit('update:modelValue', next)
  if (props.defaultProtocol === protocol) emit('update:defaultProtocol', next[0]!.protocol)
}
function chooseDefault(value: unknown) {
  const parsed = InterfaceProtocolSchema.safeParse(value)
  if (parsed.success && props.modelValue.some(endpoint => endpoint.protocol === parsed.data)) emit('update:defaultProtocol', parsed.data)
}
</script>

<template lang="pug">
FieldGroup
  FieldSet(v-for="endpoint in modelValue" :key="endpoint.protocol" :disabled="disabled")
    .flex.items-center.justify-between.gap-2
      FieldLegend(variant="label" class="mb-0") {{ labels[endpoint.protocol] }}
      Button(type="button" variant="ghost" size="icon" :disabled="disabled || modelValue.length === 1" :aria-label="`移除 ${labels[endpoint.protocol]}`" @click="remove(endpoint.protocol)")
        Trash2Icon
    FieldGroup
      Field
        FieldLabel(:for="`${prefix}-${endpoint.protocol}-url`") Base URL
        Input(:id="`${prefix}-${endpoint.protocol}-url`" data-interface-url :data-protocol="endpoint.protocol" :model-value="endpoint.base_url" type="url" required :disabled="disabled" placeholder="https://api.example.com/v1" @update:model-value="update(endpoint.protocol, { base_url: String($event) })")
      Field(orientation="horizontal" :data-disabled="endpoint.protocol === 'vertex-compatible' || disabled")
        FieldContent
          FieldLabel(:for="`${prefix}-${endpoint.protocol}-files`") 支持原生文件转储
          FieldDescription {{ endpoint.protocol === 'vertex-compatible' ? 'Vertex 兼容接口不支持原生 Files。' : '请确认此端点支持带过期时间的 Files API。' }}
        Switch(:id="`${prefix}-${endpoint.protocol}-files`" :aria-label="`${labels[endpoint.protocol]} Files`" :model-value="endpoint.native_files ?? false" :disabled="endpoint.protocol === 'vertex-compatible' || disabled" @update:model-value="update(endpoint.protocol, { native_files: $event })")
  Field(v-if="available.length")
    FieldLabel(:for="`${prefix}-add`") 添加接口
    Select(:model-value="''" :disabled="disabled" @update:model-value="add")
      SelectTrigger(:id="`${prefix}-add`" aria-label="添加接口" class="w-full")
        SelectValue(placeholder="选择接口格式")
      SelectContent
        SelectGroup
          SelectItem(v-for="protocol in available" :key="protocol" :value="protocol") {{ labels[protocol] }}
    FieldDescription(v-if="!modelValue.length") 请选择供应商使用的接口格式。
  Field(v-if="modelValue.length")
    FieldLabel(:for="`${prefix}-default`") 默认接口
    Select(:model-value="defaultProtocol" :disabled="disabled" @update:model-value="chooseDefault")
      SelectTrigger(:id="`${prefix}-default`" aria-label="默认接口" class="w-full")
        SelectValue
      SelectContent
        SelectGroup
          SelectItem(v-for="endpoint in modelValue" :key="endpoint.protocol" :value="endpoint.protocol") {{ labels[endpoint.protocol] }}
    FieldDescription 模型未单独选择接口时使用此接口。所有接口共用供应商密钥。
</template>
