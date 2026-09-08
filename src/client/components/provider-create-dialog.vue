<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import ProviderInterfaceList from '@/client/components/provider-interface-list.vue'
import CodexOAuthDialog from '@/client/components/codex-oauth-dialog.vue'
import { Button } from '@/client/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/client/ui/command'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { ProviderWriteInputSchema, type CatalogProviderSummary, type ProviderWriteInput } from '@/shared/api'
import type { InterfaceProtocol, ProviderWithInterfaces } from '@/shared/models'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean]; created: [ProviderWithInterfaces] }>()
const query = ref('')
const entries = ref<CatalogProviderSummary[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref<string | null>(null)
const warning = ref<string | null>(null)
const chosen = ref(false)
const codexOpen = ref(false)
const initialBaseUrl = ref('')
const form = reactive<Omit<ProviderWriteInput, 'default_protocol'> & { default_protocol?: InterfaceProtocol }>({ name: '', interfaces: [], api_key: '', models_dev_provider: { source: 'endpoint' } })
const valid = computed(() => ProviderWriteInputSchema.safeParse(form).success)
const protocolByNpm = new Map<string, InterfaceProtocol>([
  ['@ai-sdk/openai', 'responses'], ['@ai-sdk/anthropic', 'anthropic'], ['@ai-sdk/openai-compatible', 'chat-completions'],
])
let searchToken = 0
let controller: AbortController | undefined
async function search() {
  const token = ++searchToken
  controller?.abort()
  controller = new AbortController()
  loading.value = true
  try {
    const result = await api.catalogProviders(query.value.trim(), controller.signal)
    if (token === searchToken) entries.value = result
  } catch (cause) {
    if (token === searchToken) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (token === searchToken) loading.value = false }
}
watch(query, search)
watch(() => props.open, open => {
  if (open) { chosen.value = false; query.value = ''; error.value = warning.value = null; void search() }
  else { searchToken++; controller?.abort() }
}, { immediate: true })
onBeforeUnmount(() => { searchToken++; controller?.abort() })

function choose(provider?: CatalogProviderSummary) {
  const protocol = provider ? protocolByNpm.get(provider.npm ?? '') : 'chat-completions'
  initialBaseUrl.value = provider?.api ?? ''
  Object.assign(form, {
    name: provider?.name ?? '自定义供应商', api_key: '',
    interfaces: protocol ? [{ protocol, base_url: initialBaseUrl.value, native_files: false }] : [], default_protocol: protocol,
    models_dev_provider: provider ? { source: 'manual', provider_id: provider.id } : { source: 'endpoint' },
  })
  chosen.value = true
  error.value = warning.value = null
}
async function create() {
  if (saving.value || !valid.value) return
  saving.value = true
  error.value = null
  try {
    const input = ProviderWriteInputSchema.parse(form)
    const provider = await api.createProvider(input, value => { warning.value = value })
    if (warning.value) toast.warning(warning.value)
    emit('created', provider)
    emit('update:open', false)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  finally { saving.value = false }
}
</script>

<template lang="pug">
Dialog(:open="open" @update:open="value => { if (!saving) emit('update:open', value) }")
  DialogContent(class="max-h-[85dvh] overflow-y-auto sm:max-w-xl")
    DialogHeader
      DialogTitle 添加供应商
      DialogDescription 选择 models.dev 供应商预填连接信息，或配置自定义端点。
    template(v-if="!chosen")
      Command(:should-filter="false")
        CommandInput(placeholder="搜索 models.dev 供应商…" @update:model-value="query = String($event)")
        CommandList
          CommandGroup
            CommandItem(v-for="provider in entries" :key="provider.id" :value="provider.id" @select="choose(provider)") {{ provider.name }}
      p.h-5.text-sm.text-muted-foreground(role="status") {{ loading ? '正在搜索…' : entries.length ? '' : '没有匹配的供应商' }}
      Button(type="button" variant="outline" data-add-codex @click="codexOpen = true") 添加 Codex
      Button(type="button" variant="outline" @click="choose()") 自定义供应商
    form(v-else @submit.prevent="create")
      FieldGroup
        Field
          FieldLabel(for="create-provider-name") 名称
          Input#create-provider-name(v-model="form.name" required maxlength="100" :disabled="saving")
        Field
          FieldLabel(for="create-provider-key") API Key
          Input#create-provider-key(v-model="form.api_key" type="password" autocomplete="off" :disabled="saving")
          FieldDescription {{ form.models_dev_provider?.source === 'manual' ? '已手动关联目录供应商。模型仍需拉取或手动添加。' : '保存时将按默认端点及同源接口自动匹配目录供应商。' }}
        ProviderInterfaceList(v-model="form.interfaces" v-model:default-protocol="form.default_protocol" :initial-base-url="initialBaseUrl" :disabled="saving")
      DialogFooter(class="mt-6")
        Button(type="button" variant="outline" :disabled="saving" @click="chosen = false") 返回
        Button(type="submit" :disabled="saving || !valid") {{ saving ? '创建中…' : '创建供应商' }}
    p.min-h-5.text-sm.text-destructive(v-if="error" role="alert") {{ error }}
    p.min-h-5.text-sm.text-muted-foreground(v-if="warning" role="status") {{ warning }}
  CodexOAuthDialog(v-if="codexOpen" v-model:open="codexOpen" @created="provider => emit('created', provider)")
</template>
