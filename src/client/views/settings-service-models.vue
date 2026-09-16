<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ImagesIcon, SparklesIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import SearchableSelect from '@/client/components/searchable-select.vue'
import { isStudioImageModel } from '@/client/lib/image-studio'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Spinner } from '@/client/ui/spinner'
import { Textarea } from '@/client/ui/textarea'
import type { ModelRef } from '@/shared/model-ref'
import { canServeAsServiceModel } from '@/shared/service-model'
import {
  MAX_PLACEHOLDER_CHARS, missingRequiredPlaceholders, SERVICE_PROMPT_DEFAULTS,
} from '@/shared/service-prompts'

const config = useConfigStore()
const sync = useSyncStore()
const textKey = ref('')
const imageKey = ref('')
const titlePrompt = ref('')
const loading = ref(true)
const saving = ref(false)

const keyOf = (ref: ModelRef | null | undefined) => ref ? `${ref.provider_id}:${ref.model_id}` : ''
const refOf = (key: string): ModelRef | null => {
  const separator = key.indexOf(':')
  return separator < 0 ? null : { provider_id: Number(key.slice(0, separator)), model_id: key.slice(separator + 1) }
}

/** Each slot offers only what can do its job: read and write text, or produce an image. */
const textEntries = computed(() => config.enabledModels().filter(entry => canServeAsServiceModel(entry.model.metadata)))
const imageEntries = computed(() => config.enabledModels().filter(entry => isStudioImageModel(entry.provider, entry.model)))
const textOptions = computed(() => [
  { value: '', label: '不使用', description: '对话沿用开头文字作为名字' },
  ...textEntries.value.map(entry => ({
    value: `${entry.provider.id}:${entry.model.model_id}`,
    label: entry.model.metadata.name || entry.model.model_id,
    description: `${entry.provider.name} · ${entry.model.model_id}`,
  })),
])
const imageOptions = computed(() => [
  { value: '', label: '不使用' },
  ...imageEntries.value.map(entry => ({
    value: `${entry.provider.id}:${entry.model.model_id}`,
    label: entry.model.metadata.name || entry.model.model_id,
    description: `${entry.provider.name} · ${entry.model.model_id}`,
  })),
])

const savedText = computed(() => keyOf(sync.settings.service_models?.text))
const savedImage = computed(() => keyOf(sync.settings.service_models?.image))
const savedPrompt = computed(() =>
  sync.settings.service_prompts?.conversation_title ?? SERVICE_PROMPT_DEFAULTS.conversation_title)

const missing = computed(() => missingRequiredPlaceholders(titlePrompt.value))
const changed = computed(() =>
  textKey.value !== savedText.value || imageKey.value !== savedImage.value || titlePrompt.value !== savedPrompt.value)

watch(savedText, value => { textKey.value = value; saving.value = false })
watch(savedImage, value => { imageKey.value = value; saving.value = false })
watch(savedPrompt, value => { titlePrompt.value = value; saving.value = false })
watch(() => sync.lastError, error => { if (error) saving.value = false })

async function load() {
  loading.value = true
  try {
    if (!config.loaded) await config.load()
    await config.loadEnabledModelList()
    textKey.value = savedText.value
    imageKey.value = savedImage.value
    titlePrompt.value = savedPrompt.value
  }
  catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}

function save() {
  if (missing.value.length > 0) return
  saving.value = true
  const sent = sync.send({
    type: 'settings.update', request_id: crypto.randomUUID(),
    settings: {
      service_models: { text: refOf(textKey.value), image: refOf(imageKey.value) },
      service_prompts: { conversation_title: titlePrompt.value },
    },
  })
  if (!sent) {
    saving.value = false
    toast.error('未连接')
  }
}

onMounted(load)
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 全局服务模型
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 全局服务模型
        p.text-sm.text-muted-foreground
          | 应用自己使用的模型，每种能力一个。留空就是不用，对应的功能不会发生。

      .flex.items-center.gap-2(v-if="loading")
        Spinner
        span.text-sm.text-muted-foreground 加载中

      template(v-else)
        Card
          CardHeader
            CardTitle.flex.items-center.gap-2
              SparklesIcon
              | 文本
            CardDescription 给对话起名这类杂活。挑便宜快的，它的输出很短。
          CardContent
            FieldGroup
              Field
                FieldLabel(for="service-text-model") 模型
                SearchableSelect#service-text-model(
                  v-model="textKey" :options="textOptions" :disabled="saving"
                  placeholder="选择文本模型" search-placeholder="搜索供应商、模型名称或 ID…")
                FieldDescription 只列出能读文本也能写文本的模型。

              Field
                FieldLabel(for="service-title-prompt") 对话命名提示词
                Textarea#service-title-prompt(v-model="titlePrompt" rows="7" class="font-mono text-sm" :disabled="saving")
                FieldDescription
                  | 用 {{ '{' }}user_message:1{{ '}' }} 引用对话的第一条消息，最多取前 {{ MAX_PLACEHOLDER_CHARS }} 个字符。
                FieldDescription(v-if="missing.length" class="text-destructive")
                  | 必须包含 {{ missing.join('、') }}，否则模型看不到要命名的内容。

        Card
          CardHeader
            CardTitle.flex.items-center.gap-2
              ImagesIcon
              | 图片
            CardDescription Studio 和聊天里的生图工具默认使用的模型。
          CardContent
            FieldGroup
              Field
                FieldLabel(for="service-image-model") 模型
                SearchableSelect#service-image-model(
                  v-model="imageKey" :options="imageOptions" :disabled="saving"
                  placeholder="选择生图模型" search-placeholder="搜索供应商、模型名称或 ID…")

        Card
          CardFooter.flex.items-center.justify-between.gap-2.pt-6
            Button(
              type="button" variant="ghost" class="min-h-10"
              :disabled="saving || titlePrompt === SERVICE_PROMPT_DEFAULTS.conversation_title"
              @click="titlePrompt = SERVICE_PROMPT_DEFAULTS.conversation_title") 恢复默认提示词
            Button(type="button" class="min-h-10" :disabled="saving || !changed || missing.length > 0" @click="save")
              | {{ saving ? '保存中' : '保存' }}
</template>
