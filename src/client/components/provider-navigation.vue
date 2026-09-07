<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { PlusIcon } from '@lucide/vue'
import { RouterLink, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import { useConfigStore } from '@/client/stores/config'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/client/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Separator } from '@/client/ui/separator'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'
import type { PresetProvider } from '@/server/plugins/llm/presets'

defineProps<{ selectedProviderId?: number | null }>()
const config = useConfigStore()
const router = useRouter()
const query = ref('')
const presets = ref<PresetProvider[]>([])
const chosen = ref('custom')
const adding = ref(false)
const loading = ref(true)
const visibleProviders = computed(() => {
  const search = query.value.trim().toLocaleLowerCase()
  return config.providers.filter(provider => [provider.name, provider.protocol].some(value => value.toLocaleLowerCase().includes(search)))
})

onMounted(async () => {
  try {
    presets.value = await api.presets()
    if (!config.loaded) await config.load()
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
})

function onChoose(value: unknown) {
  if (typeof value === 'string') chosen.value = value
}

async function addProvider() {
  if (adding.value) return
  adding.value = true
  try {
    const preset = presets.value.find(item => item.key === chosen.value)
    const created = preset
      ? await api.createProvider({ name: preset.name, protocol: preset.protocol, base_url: preset.base_url, native_files: preset.native_files })
      : await api.createProvider({ name: '自定义供应商', protocol: 'openai-completions', base_url: 'https://api.example.com/v1' })
    if (preset) for (const model of preset.models) await api.createModel(created.id, { model_id: model.model_id, display_name: model.display_name, capabilities: model.capabilities })
    await config.load()
    toast.success('已添加供应商')
    await router.push(`/settings/providers/${created.id}`)
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { adding.value = false }
}
</script>

<template lang="pug">
nav.flex.h-full.min-h-0.flex-col(aria-label="供应商")
  .flex.shrink-0.flex-col.gap-4.p-4
    h1.text-lg.font-semibold 模型服务
    FieldGroup(class="gap-3")
      Field
        FieldLabel.sr-only(for="provider-search") 搜索供应商
        Input#provider-search(v-model="query" type="search" placeholder="搜索供应商…" class="min-h-10")
      Field
        FieldLabel(for="provider-preset") 添加供应商
        Select(:model-value="chosen" @update:model-value="onChoose")
          SelectTrigger#provider-preset(class="min-h-10 w-full")
            SelectValue(placeholder="选择供应商模板")
          SelectContent
            SelectGroup
              SelectItem(value="custom") 自定义供应商
              SelectItem(v-for="preset in presets" :key="preset.key" :value="preset.key") {{ preset.name }}
        Button(variant="outline" class="min-h-10" :disabled="adding || loading" @click="addProvider")
          PlusIcon(data-icon="inline-start")
          | {{ adding ? '添加中…' : '添加供应商' }}
  Separator
  .oc-scroll.min-h-0.flex-1.overflow-y-auto.p-2
    .flex.flex-col.gap-2(v-if="loading" aria-label="正在加载供应商")
      Skeleton(v-for="index in 3" :key="index" class="h-20 w-full")
    ItemGroup(v-else class="gap-1")
      Item(v-for="provider in visibleProviders" :key="provider.id" as-child size="sm" :variant="selectedProviderId === provider.id ? 'muted' : 'default'")
        RouterLink(:to="`/settings/providers/${provider.id}`" :aria-current="selectedProviderId === provider.id ? 'page' : undefined")
          ItemContent
            ItemTitle {{ provider.name }}
            ItemDescription {{ provider.protocol }}
            .flex.flex-wrap.gap-1
              Badge(:variant="provider.enabled ? 'secondary' : 'outline'") {{ provider.enabled ? '启用' : '停用' }}
              Badge(variant="outline") {{ provider.has_key ? '已配置密钥' : '无密钥' }}
      Empty(v-if="!visibleProviders.length")
        EmptyHeader
          EmptyTitle {{ query ? '没有匹配的供应商' : '尚未添加供应商' }}
          EmptyDescription {{ query ? '试试其他名称或协议。' : '从上方选择模板或添加自定义供应商。' }}
</template>
