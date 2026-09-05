<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { useConfigStore } from '@/client/stores/config'
import type { PresetProvider } from '@/server/plugins/llm/presets'

const config = useConfigStore()
const router = useRouter()
const presets = ref<PresetProvider[]>([])
const chosen = ref('')
const status = ref('')

onMounted(async () => { presets.value = await api.presets(); await config.load() })

// reka-ui emits `AcceptableValue`; narrow here rather than in the template.
function onChoose(key: unknown) {
  chosen.value = typeof key === 'string' ? key : ''
}

async function addFromPreset() {
  const preset = presets.value.find((p) => p.key === chosen.value)
  status.value = ''
  try {
    const created = preset
      ? await api.createProvider({ name: preset.name, protocol: preset.protocol, base_url: preset.base_url, native_files: preset.native_files })
      : await api.createProvider({ name: '自定义供应商', protocol: 'openai-completions', base_url: 'https://api.example.com/v1' })
    if (preset) for (const m of preset.models) await api.createModel(created.id, { model_id: m.model_id, display_name: m.display_name, capabilities: m.capabilities })
    await config.load()
    await router.push(`/settings/providers/${created.id}`)
  } catch (err) {
    status.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template lang="pug">
.mx-auto.max-w-2xl.p-4.flex.flex-col.gap-4
  h1.text-lg.font-semibold 供应商
  .flex.gap-2
    Select(:model-value="chosen" @update:model-value="onChoose")
      SelectTrigger(class="w-56")
        SelectValue(placeholder="从预制模板添加…")
      SelectContent
        SelectItem(v-for="p in presets" :key="p.key" :value="p.key") {{ p.name }}
    Button(@click="addFromPreset") 添加
  p.text-xs.text-destructive(v-if="status") {{ status }}
  ul.divide-y.rounded-md.border
    li.flex.items-center.gap-3.p-3(v-for="p in config.providers" :key="p.id")
      RouterLink.font-medium(:to="`/settings/providers/${p.id}`") {{ p.name }}
      span.text-xs.text-muted-foreground {{ p.protocol }}
      span.ml-auto.text-xs(:class="p.enabled ? 'text-emerald-600' : 'text-muted-foreground'") {{ p.enabled ? '启用' : '停用' }}
      span.text-xs.text-muted-foreground {{ p.has_key ? '已配置密钥' : '无密钥' }}
  RouterLink.text-sm.text-muted-foreground(to="/settings/plugins") 插件开关 →
</template>
