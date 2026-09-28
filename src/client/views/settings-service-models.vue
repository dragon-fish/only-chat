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
import { canServeAsServiceModel, canServeAsFileModel } from '@/shared/service-model'
import {
  MAX_PLACEHOLDER_CHARS, missingRequiredPlaceholders, SERVICE_PROMPT_DEFAULTS,
} from '@/shared/service-prompts'

const config = useConfigStore()
const sync = useSyncStore()
const textKey = ref('')
const imageKey = ref('')
const fileKey = ref('')
const filePrompt = ref('')
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

const fileOptions = computed(() => [
  { value: '', label: '不使用' },
  ...config.enabledModels().filter(entry => canServeAsFileModel(entry.model.metadata)).map(entry => ({
    value: `${entry.provider.id}:${entry.model.model_id}`, label: entry.model.metadata.name || entry.model.model_id,
    description: `${entry.provider.name} · ${entry.model.metadata.modalities?.input.join(', ')}`,
  })),
])
const savedFile = computed(() => keyOf(sync.settings.service_models?.file_understanding))
const savedFilePrompt = computed(() => sync.settings.service_prompts?.file_understanding ?? SERVICE_PROMPT_DEFAULTS.file_understanding)
const savedText = computed(() => keyOf(sync.settings.service_models?.text))
const savedImage = computed(() => keyOf(sync.settings.service_models?.image))
const savedPrompt = computed(() =>
  sync.settings.service_prompts?.conversation_title ?? SERVICE_PROMPT_DEFAULTS.conversation_title)

const missing = computed(() => missingRequiredPlaceholders(titlePrompt.value))
const changed = computed(() =>
  fileKey.value !== savedFile.value || filePrompt.value !== savedFilePrompt.value || textKey.value !== savedText.value || imageKey.value !== savedImage.value || titlePrompt.value !== savedPrompt.value)

watch(savedFile, value => { fileKey.value = value; saving.value = false })
watch(savedFilePrompt, value => { filePrompt.value = value; saving.value = false })
watch(savedText, value => { textKey.value = value; saving.value = false })
watch(savedImage, value => { imageKey.value = value; saving.value = false })
watch(savedPrompt, value => { titlePrompt.value = value; saving.value = false })
watch(() => sync.lastError, error => { if (error) saving.value = false })

async function load() {
  loading.value = true
  try {
    if (!config.loaded) await config.load()
    await config.loadEnabledModelList()
    fileKey.value = savedFile.value
    filePrompt.value = savedFilePrompt.value
    textKey.value = savedText.value
    imageKey.value = savedImage.value
    titlePrompt.value = savedPrompt.value
  }
  catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}

function save() {
  if (missing.value.length > 0 || !filePrompt.value.trim()) return
  saving.value = true
  const sent = sync.send({
    type: 'settings.update', request_id: crypto.randomUUID(),
    settings: {
      service_models: { text: refOf(textKey.value), image: refOf(imageKey.value), file_understanding: refOf(fileKey.value) },
      service_prompts: { conversation_title: titlePrompt.value, file_understanding: filePrompt.value },
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
                Textarea#service-title-prompt(v-model="titlePrompt" rows="7" class="max-h-96 overflow-y-auto font-mono text-sm" :disabled="saving")
                FieldDescription
                  | 用 {{ '{' }}user_message:1{{ '}' }} 引用对话的第一条消息，最多取前 {{ MAX_PLACEHOLDER_CHARS }} 个字符。
                FieldDescription(v-if="missing.length" class="text-destructive")
                  | 必须包含 {{ missing.join('、') }}，否则模型看不到要命名的内容。
          CardFooter
            Button(
              type="button" variant="ghost" class="min-h-10"
              :disabled="saving || titlePrompt === SERVICE_PROMPT_DEFAULTS.conversation_title"
              @click="titlePrompt = SERVICE_PROMPT_DEFAULTS.conversation_title") 恢复对话命名默认提示词

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
          CardHeader
            CardTitle 文件理解
            CardDescription analyze_file 使用的模型。可分析图片、PDF、音频或视频，具体取决于所选模型和接口。
          CardContent
            FieldGroup
              Field
                FieldLabel(for="service-file-model") 模型
                SearchableSelect#service-file-model(v-model="fileKey" :options="fileOptions" :disabled="saving" placeholder="选择文件理解模型" search-placeholder="搜索供应商、模型名称或 ID…")
              Field
                FieldLabel(for="service-file-prompt") 系统提示词
                Textarea#service-file-prompt(v-model="filePrompt" rows="12" class="max-h-96 overflow-y-auto font-mono text-sm" :disabled="saving")
                FieldDescription 本次问题和文件单独传入。默认提示词侧重详细视觉描述，可按用途修改。
          CardFooter
            Button(
              type="button" variant="ghost" class="min-h-10"
              :disabled="saving || filePrompt === SERVICE_PROMPT_DEFAULTS.file_understanding"
              @click="filePrompt = SERVICE_PROMPT_DEFAULTS.file_understanding") 恢复文件理解默认提示词

        .sticky.bottom-0.-mx-4.flex.items-center.justify-end.gap-3.border-t.p-4.backdrop-blur(class="bg-background/95 pb-[calc(1rem+env(safe-area-inset-bottom))] md:-mx-6 md:px-6 lg:-mx-8 lg:px-8")
          .flex.items-center.gap-2(aria-label="服务模型操作")
            span.text-sm.text-muted-foreground {{ changed ? '有未保存的更改' : '更改已保存' }}
            Button(type="button" class="min-h-10" :disabled="saving || !changed || missing.length > 0 || !filePrompt.trim()" @click="save")
              | {{ saving ? '保存中…' : '保存' }}
</template>
