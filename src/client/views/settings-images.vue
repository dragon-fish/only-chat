<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ImagesIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { isStudioImageModel } from '@/client/lib/image-studio'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Spinner } from '@/client/ui/spinner'

const config = useConfigStore()
const sync = useSyncStore()
const selected = ref('')
const loading = ref(true)
const saving = ref(false)
const entries = computed(() => config.enabledModels().filter(entry => isStudioImageModel(entry.provider, entry.model)))
const savedKey = computed(() => sync.settings.image_model ? `${sync.settings.image_model.provider_id}:${sync.settings.image_model.model_id}` : '')
watch(savedKey, value => { selected.value = value; saving.value = false })
watch(() => sync.lastError, error => { if (error) saving.value = false })
async function load() {
  loading.value = true
  try {
    if (!config.loaded) await config.load()
    await config.loadEnabledModels(false, { image_output: true })
    selected.value = savedKey.value
  } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}
function save() {
  const separator = selected.value.indexOf(':')
  const image_model = separator < 0 ? null : {
    provider_id: Number(selected.value.slice(0, separator)), model_id: selected.value.slice(separator + 1),
  }
  saving.value = true
  if (!sync.send({ type: 'settings.update', request_id: crypto.randomUUID(), settings: { image_model } })) {
    saving.value = false
    toast.error('未连接')
  }
}
onMounted(load)
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    SettingsBackButton
    span.truncate.text-sm.font-medium 图片生成
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 图片生成
        p.text-sm.text-muted-foreground 设置 Studio 和聊天工具使用的默认生图模型。
      Card
        CardHeader
          CardTitle.flex.items-center.gap-2
            ImagesIcon
            | 默认生图模型
          CardDescription 会话和供应商可以覆盖这个全局默认值。
        CardContent
          FieldGroup
            Field
              FieldLabel(for="global-image-model") 模型
              NativeSelect#global-image-model(v-model="selected" class="w-full" :disabled="loading || saving")
                NativeSelectOption(value="") 不设置
                NativeSelectOption(v-for="entry in entries" :key="`${entry.provider.id}:${entry.model.model_id}`" :value="`${entry.provider.id}:${entry.model.model_id}`") {{ entry.model.metadata.name ?? entry.model.model_id }} · {{ entry.provider.name }}
              FieldDescription 仅显示通过 OpenAI-compatible Images API 调用的图片输出模型。
        CardFooter
          Button(:disabled="loading || saving || selected === savedKey" @click="save")
            Spinner(v-if="saving" data-icon="inline-start")
            | 保存
</template>
