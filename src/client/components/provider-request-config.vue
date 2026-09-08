<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import ProviderInterfaceList from '@/client/components/provider-interface-list.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { Button } from '@/client/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Separator } from '@/client/ui/separator'
import type { CatalogProviderSummary, ProviderWriteInput } from '@/shared/api'

const props = defineProps<{
  open: boolean
  modelValue: ProviderWriteInput
  catalogProviders: CatalogProviderSummary[]
  currentCatalogProviderId?: string | null
}>()
const emit = defineEmits<{ 'update:open': [value: boolean]; apply: [value: ProviderWriteInput] }>()
const clone = (value: ProviderWriteInput): ProviderWriteInput => JSON.parse(JSON.stringify(value))
const draft = ref<ProviderWriteInput>(clone(props.modelValue))
const baseline = ref('')
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)

function reset() {
  draft.value = clone(props.modelValue)
  baseline.value = JSON.stringify(draft.value)
}
watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
async function setOpen(next: boolean) {
  if (next || await leaveGuard.value?.confirmLeave()) emit('update:open', next)
}
function chooseAssociation(value: unknown) {
  if (typeof value !== 'string') return
  draft.value.models_dev_provider = value === 'endpoint' ? { source: 'endpoint' } : { source: 'manual', provider_id: value }
}
function apply() {
  emit('apply', clone(draft.value))
  baseline.value = JSON.stringify(draft.value)
  emit('update:open', false)
}
</script>

<template lang="pug">
ResponsiveOverlay(:open="open" title="请求配置" @update:open="setOpen")
  template(#status)
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
  form#provider-request-config-form.flex.flex-col.gap-6(@submit.prevent="apply")
    ProviderInterfaceList(v-model="draft.interfaces" v-model:default-protocol="draft.default_protocol")
    Separator
    FieldGroup
      Field
        FieldLabel(for="provider-association") models.dev 关联
        Select(:model-value="draft.models_dev_provider?.source === 'manual' ? draft.models_dev_provider.provider_id : 'endpoint'" @update:model-value="chooseAssociation")
          SelectTrigger#provider-association(class="w-full")
            SelectValue
          SelectContent
            SelectGroup
              SelectItem(value="endpoint") 按端点自动匹配
              SelectItem(v-for="entry in catalogProviders" :key="entry.id" :value="entry.id") {{ entry.name }}
        FieldDescription {{ draft.models_dev_provider?.source === 'manual' ? '手动关联将保留，不受端点修改影响。' : `保存时按默认端点和同源接口匹配。当前关联：${currentCatalogProviderId ?? '未匹配'}` }}
  template(#footer)
    Button(type="button" variant="outline" class="min-h-10" @click="setOpen(false)") 取消
    Button(type="submit" form="provider-request-config-form" class="min-h-10") 应用
</template>
