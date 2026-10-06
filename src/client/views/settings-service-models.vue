<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronRightIcon, FoldVerticalIcon, ImagesIcon, SparklesIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import ModelCapabilityIcons from '@/client/components/model-capability-icons.vue'
import SearchableSelect from '@/client/components/searchable-select.vue'
import { isStudioImageModel } from '@/client/lib/image-studio'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Badge } from '@/client/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/client/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Spinner } from '@/client/ui/spinner'
import { Textarea } from '@/client/ui/textarea'
import type { ModelRef } from '@/shared/model-ref'
import { canServeAsServiceModel, canServeAsFileModel } from '@/shared/service-model'
import {
  MAX_PLACEHOLDER_CHARS, missingRequiredPlaceholders, SERVICE_PROMPT_DEFAULTS, servicePromptPatch,
} from '@/shared/service-prompts'

const config = useConfigStore()
const sync = useSyncStore()
const textKey = ref('')
const imageKey = ref('')
const fileKey = ref('')
const compactionKey = ref('')
const filePrompt = ref('')
const titlePrompt = ref('')
const compactionPrompt = ref('')
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
/** Same capability as the text slot: it reads a flattened transcript and writes a summary. */
const compactionOptions = computed(() => [
  { value: '', label: '不使用' },
  ...textOptions.value.slice(1),
])
const imageOptions = computed(() => [
  { value: '', label: '不使用' },
  ...imageEntries.value.map(entry => ({
    value: `${entry.provider.id}:${entry.model.model_id}`,
    label: entry.model.metadata.name || entry.model.model_id,
    description: `${entry.provider.name} · ${entry.model.model_id}`,
  })),
])

const fileEntries = computed(() => new Map(config.enabledModels()
  .filter(entry => canServeAsFileModel(entry.model.metadata))
  .map(entry => [`${entry.provider.id}:${entry.model.model_id}`, entry])))
/** Only called for keys `fileEntries` has; the template checks first. */
const fileModel = (value: string) => fileEntries.value.get(value)!.model
const fileOptions = computed(() => [
  { value: '', label: '不使用' },
  ...[...fileEntries.value].map(([value, entry]) => ({
    value, label: entry.model.metadata.name || entry.model.model_id,
    description: `${entry.provider.name} · ${entry.model.model_id}`,
  })),
])
const savedFile = computed(() => keyOf(sync.settings.service_models?.file_understanding))
const savedFilePrompt = computed(() => sync.settings.service_prompts?.file_understanding ?? SERVICE_PROMPT_DEFAULTS.file_understanding)
const savedText = computed(() => keyOf(sync.settings.service_models?.text))
const savedImage = computed(() => keyOf(sync.settings.service_models?.image))
const savedCompaction = computed(() => keyOf(sync.settings.service_models?.compaction))
const savedPrompt = computed(() =>
  sync.settings.service_prompts?.conversation_title ?? SERVICE_PROMPT_DEFAULTS.conversation_title)
const savedCompactionPrompt = computed(() =>
  sync.settings.service_prompts?.compaction ?? SERVICE_PROMPT_DEFAULTS.compaction)

const missing = computed(() => missingRequiredPlaceholders(titlePrompt.value))
/**
 * Prompts are for the few who tune them, so they start folded. A prompt that differs from its
 * default opens, or someone who changed it forgets they did; so does one that cannot be saved,
 * whose error would otherwise sit out of sight.
 */
const titleCustom = computed(() => titlePrompt.value !== SERVICE_PROMPT_DEFAULTS.conversation_title)
const fileCustom = computed(() => filePrompt.value !== SERVICE_PROMPT_DEFAULTS.file_understanding)
const compactionCustom = computed(() => compactionPrompt.value !== SERVICE_PROMPT_DEFAULTS.compaction)
const titleOpen = ref(false)
const fileOpen = ref(false)
const compactionOpen = ref(false)
watch([titleCustom, missing], ([custom, absent]) => { if (custom || absent.length) titleOpen.value = true })
watch([fileCustom, () => filePrompt.value.trim()], ([custom, text]) => { if (custom || !text) fileOpen.value = true })
watch([compactionCustom, () => compactionPrompt.value.trim()], ([custom, text]) => { if (custom || !text) compactionOpen.value = true })
const changed = computed(() =>
  fileKey.value !== savedFile.value || filePrompt.value !== savedFilePrompt.value || textKey.value !== savedText.value || imageKey.value !== savedImage.value || compactionKey.value !== savedCompaction.value || compactionPrompt.value !== savedCompactionPrompt.value || titlePrompt.value !== savedPrompt.value)

watch(savedFile, value => { fileKey.value = value; saving.value = false })
watch(savedFilePrompt, value => { filePrompt.value = value; saving.value = false })
watch(savedText, value => { textKey.value = value; saving.value = false })
watch(savedImage, value => { imageKey.value = value; saving.value = false })
watch(savedCompaction, value => { compactionKey.value = value; saving.value = false })
watch(savedPrompt, value => { titlePrompt.value = value; saving.value = false })
watch(savedCompactionPrompt, value => { compactionPrompt.value = value; saving.value = false })
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
    compactionKey.value = savedCompaction.value
    titlePrompt.value = savedPrompt.value
    compactionPrompt.value = savedCompactionPrompt.value
  }
  catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}

function save() {
  if (missing.value.length > 0 || !filePrompt.value.trim() || !compactionPrompt.value.trim()) return
  saving.value = true
  const sent = sync.send({
    type: 'settings.update', request_id: crypto.randomUUID(),
    settings: {
      service_models: {
        text: refOf(textKey.value), image: refOf(imageKey.value), file_understanding: refOf(fileKey.value),
        compaction: refOf(compactionKey.value),
      },
      // A prompt equal to its default is sent as `null` and stored as unset (spec §9).
      service_prompts: {
        conversation_title: servicePromptPatch('conversation_title', titlePrompt.value),
        file_understanding: servicePromptPatch('file_understanding', filePrompt.value),
        compaction: servicePromptPatch('compaction', compactionPrompt.value),
      },
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

              Collapsible(v-model:open="titleOpen")
                CollapsibleTrigger.group.flex.min-h-10.items-center.gap-2.text-sm.text-muted-foreground(class="hover:text-foreground")
                  ChevronRightIcon(class="size-4 transition-transform group-data-[state=open]:rotate-90")
                  | 自定义提示词
                  Badge(v-if="titleCustom" variant="secondary") 已自定义
                CollapsibleContent
                  Field.pt-2
                    FieldLabel(for="service-title-prompt") 对话命名提示词
                    Textarea#service-title-prompt(v-model="titlePrompt" rows="7" class="max-h-96 overflow-y-auto font-mono text-sm" :disabled="saving")
                    FieldDescription
                      | 用 {{ '{' }}user_message:1{{ '}' }} 引用对话的第一条消息，最多取前 {{ MAX_PLACEHOLDER_CHARS }} 个字符。
                    FieldDescription(v-if="missing.length" class="text-destructive")
                      | 必须包含 {{ missing.join('、') }}，否则模型看不到要命名的内容。
                    Button.self-start(
                      type="button" variant="ghost" class="min-h-10"
                      :disabled="saving || !titleCustom"
                      @click="titlePrompt = SERVICE_PROMPT_DEFAULTS.conversation_title") 恢复默认

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
                  template(#option-extra="{ option }")
                    ModelCapabilityIcons(v-if="fileEntries.has(option.value)" :model="fileModel(option.value)")
              Collapsible(v-model:open="fileOpen")
                CollapsibleTrigger.group.flex.min-h-10.items-center.gap-2.text-sm.text-muted-foreground(class="hover:text-foreground")
                  ChevronRightIcon(class="size-4 transition-transform group-data-[state=open]:rotate-90")
                  | 自定义提示词
                  Badge(v-if="fileCustom" variant="secondary") 已自定义
                CollapsibleContent
                  Field.pt-2
                    FieldLabel(for="service-file-prompt") 系统提示词
                    Textarea#service-file-prompt(v-model="filePrompt" rows="12" class="max-h-96 overflow-y-auto font-mono text-sm" :disabled="saving")
                    FieldDescription 文件、文件类型和本次问题会单独传入。默认提示词覆盖图片、PDF、音频与视频。
                    Button.self-start(
                      type="button" variant="ghost" class="min-h-10"
                      :disabled="saving || !fileCustom"
                      @click="filePrompt = SERVICE_PROMPT_DEFAULTS.file_understanding") 恢复默认

        Card
          CardHeader
            CardTitle.flex.items-center.gap-2
              FoldVerticalIcon
              | 上下文压缩
            CardDescription 压缩时让模型写摘要的指令，以及对话已超出当前模型窗口时使用的备用模型。
          CardContent
            FieldGroup
              Field
                FieldLabel(for="service-compaction-model") 备用模型
                SearchableSelect#service-compaction-model(
                  v-model="compactionKey" :options="compactionOptions" :disabled="saving"
                  placeholder="选择压缩备用模型" search-placeholder="搜索供应商、模型名称或 ID…")
                FieldDescription 对话已超出当前模型窗口时，用这个模型把历史压平后写摘要。建议选便宜、上下文大的模型；未设置时，超长对话无法自动压缩。只列出能读文本也能写文本的模型。
              Collapsible(v-model:open="compactionOpen")
                CollapsibleTrigger.group.flex.min-h-10.items-center.gap-2.text-sm.text-muted-foreground(class="hover:text-foreground")
                  ChevronRightIcon(class="size-4 transition-transform group-data-[state=open]:rotate-90")
                  | 自定义压缩指令
                  Badge(v-if="compactionCustom" variant="secondary") 已自定义
                CollapsibleContent
                  Field.pt-2
                    FieldLabel(for="service-compaction-prompt") 压缩指令
                    Textarea#service-compaction-prompt(v-model="compactionPrompt" rows="12" class="max-h-96 overflow-y-auto font-mono text-sm" :disabled="saving")
                    FieldDescription
                      | 追加在对话末尾、请模型写摘要的整段指令，可以全部改写。
                      code {date}
                      |  会替换为当天日期；手动压缩的重点说明会自动附在后面。
                    Button.self-start(
                      type="button" variant="ghost" class="min-h-10"
                      :disabled="saving || !compactionCustom"
                      @click="compactionPrompt = SERVICE_PROMPT_DEFAULTS.compaction") 恢复默认

        .sticky.bottom-0.-mx-4.flex.items-center.justify-end.gap-3.border-t.p-4.backdrop-blur(class="bg-background/95 pb-[calc(1rem+env(safe-area-inset-bottom))] md:-mx-6 md:px-6 lg:-mx-8 lg:px-8")
          .flex.items-center.gap-2(aria-label="服务模型操作")
            span.text-sm.text-muted-foreground {{ changed ? '有未保存的更改' : '更改已保存' }}
            Button(type="button" class="min-h-10" :disabled="saving || !changed || missing.length > 0 || !filePrompt.trim() || !compactionPrompt.trim()" @click="save")
              | {{ saving ? '保存中…' : '保存' }}
</template>
