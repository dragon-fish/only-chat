<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import ProviderSettingsForm from '@/client/components/provider-settings-form.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { providerSettingsDraft } from '@/client/lib/provider-settings'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/client/ui/field'
import { Switch } from '@/client/ui/switch'
import { ProviderWriteInputSchema, type ProviderWriteInput } from '@/shared/api'

const props = defineProps<{ open: boolean; providerId: number | null }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const config = useConfigStore()
const router = useRouter()
const form = ref<ProviderWriteInput | null>(null)
const baseline = ref('')
const saving = ref(false)
const associationWarning = ref<string | null>(null)
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
const provider = computed(() => config.providerRecords.find(item => item.id === props.providerId))
const dirty = computed(() => form.value !== null && JSON.stringify(form.value) !== baseline.value)
const valid = computed(() => form.value !== null && ProviderWriteInputSchema.safeParse(form.value).success)

function reset() {
  form.value = provider.value ? providerSettingsDraft(provider.value) : null
  baseline.value = JSON.stringify(form.value)
  associationWarning.value = null
}
watch([() => props.open, () => props.providerId], ([open]) => {
  if (!open) return
  reset()
  void config.loadCatalogProviders()
}, { immediate: true })

async function setOpen(next: boolean) {
  if (next || await leaveGuard.value?.confirmLeave()) emit('update:open', next)
}
async function save() {
  if (!form.value || !valid.value || saving.value || props.providerId === null) return false
  const id = props.providerId
  const submitted: ProviderWriteInput = JSON.parse(JSON.stringify(form.value))
  saving.value = true
  try {
    let warning: string | null = null
    await api.updateProvider(id, { ...submitted, api_key: submitted.api_key || undefined }, value => { warning = value })
    associationWarning.value = warning
    config.invalidateProviderModels(id)
    await config.load()
    try {
      await Promise.all([
        config.refreshSelectedModels(id),
        config.pickerLoaded ? config.loadEnabledModelList() : Promise.resolve(),
      ])
    }
    catch { /* The next selected-model read retries stale metadata. */ }
    if (props.open && props.providerId === id) {
      reset()
      toast.success('已保存供应商')
      emit('update:open', false)
    }
    return true
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); return false }
  finally { saving.value = false }
}
async function applySettings(value: ProviderWriteInput) {
  form.value = value
  return save()
}
async function openFullSettings() {
  if (!await leaveGuard.value?.confirmLeave()) return
  emit('update:open', false)
  if (props.providerId !== null) await router.push(`/settings/providers/${props.providerId}`)
}
</script>

<template lang="pug">
ResponsiveOverlay(:open="open" title="编辑供应商" mode="dialog" @update:open="setOpen")
  form#provider-quick-settings-form.flex.flex-col.gap-6(v-if="form && provider" @submit.prevent="save")
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
    Field(orientation="horizontal" class="min-h-10")
      FieldContent
        FieldLabel(:for="`quick-provider-${provider.id}-enabled`") 启用供应商
        FieldDescription 控制此供应商及其模型是否可用于聊天。
      Switch(:id="`quick-provider-${provider.id}-enabled`" v-model="form.enabled" aria-label="启用供应商" class="after:-inset-y-3" :disabled="saving")
    ProviderSettingsForm(
      v-model="form"
      :id-prefix="`quick-provider-${provider.id}`"
      :catalog-providers="config.catalogProviders"
      :current-catalog-provider-id="provider.models_dev_provider_id"
      :has-key="provider.has_key"
      :disabled="saving"
      :persist="applySettings")
    p.text-sm.text-muted-foreground(v-if="associationWarning" role="status") {{ associationWarning }}
  p.text-sm.text-muted-foreground(v-else) 找不到这个供应商。
  template(#footer)
    Button(type="button" variant="outline" class="min-h-10" @click="openFullSettings") 打开完整设置
    Button(type="submit" form="provider-quick-settings-form" class="min-h-10" :disabled="!valid || saving") {{ saving ? '保存中…' : '保存' }}
</template>
