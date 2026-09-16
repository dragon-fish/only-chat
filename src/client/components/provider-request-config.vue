<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import ProviderInterfaceList from '@/client/components/provider-interface-list.vue'
import SearchableSelect from '@/client/components/searchable-select.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { Button } from '@/client/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Separator } from '@/client/ui/separator'
import { ProviderWriteInputSchema, type CatalogProviderSummary, type ProviderWriteInput } from '@/shared/api'

const props = defineProps<{
  open: boolean
  modelValue: ProviderWriteInput
  catalogProviders: CatalogProviderSummary[]
  currentCatalogProviderId?: string | null
  persist: (value: ProviderWriteInput) => Promise<boolean>
}>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const clone = (value: ProviderWriteInput): ProviderWriteInput => JSON.parse(JSON.stringify(value))
const draft = ref<ProviderWriteInput>(clone(props.modelValue))
const baseline = ref('')
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const valid = computed(() => ProviderWriteInputSchema.safeParse(draft.value).success)
const applying = ref(false)
const associationOptions = computed(() => [
  { value: 'endpoint', label: '按端点自动匹配', description: props.currentCatalogProviderId ?? '当前未匹配' },
  ...props.catalogProviders.map(entry => ({ value: entry.id, label: entry.name, description: entry.id })),
])
const association = computed({
  get: () => draft.value.models_dev_provider?.source === 'manual' ? draft.value.models_dev_provider.provider_id : 'endpoint',
  set: chooseAssociation,
})

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
async function apply() {
  if (applying.value || !valid.value) return
  const submitted = clone(draft.value)
  applying.value = true
  try {
    if (!await props.persist(submitted)) return
    baseline.value = JSON.stringify(submitted)
    emit('update:open', false)
  } finally { applying.value = false }
}
</script>

<template lang="pug">
ResponsiveOverlay(:open="open" title="API 地址配置" @update:open="setOpen")
  template(#status)
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
  form#provider-request-config-form.flex.flex-col.gap-6(@submit.prevent="apply")
    ProviderInterfaceList(v-model="draft.interfaces" v-model:default-protocol="draft.default_protocol" :disabled="applying")
    Separator
    FieldGroup
      Field
        FieldLabel(for="provider-association") models.dev 关联
        SearchableSelect#provider-association(
          v-model="association"
          :options="associationOptions"
          placeholder="选择 models.dev 供应商"
          search-placeholder="搜索供应商…"
          empty-text="没有匹配的供应商"
          :disabled="applying")
        FieldDescription {{ draft.models_dev_provider?.source === 'manual' ? '手动关联将保留，不受端点修改影响。' : `保存时按默认端点和同源接口匹配。当前关联：${currentCatalogProviderId ?? '未匹配'}` }}
  template(#footer)
    Button(type="button" variant="outline" class="min-h-10" :disabled="applying" @click="setOpen(false)") 取消
    Button(type="submit" form="provider-request-config-form" class="min-h-10" :disabled="applying || !valid") {{ applying ? '应用中…' : '应用' }}
</template>
