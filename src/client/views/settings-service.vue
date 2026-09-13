<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { SparklesIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { useConfigStore } from '@/client/stores/config'
import { useSyncStore } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Spinner } from '@/client/ui/spinner'
import { Textarea } from '@/client/ui/textarea'
import { canServeAsServiceModel } from '@/shared/service-model'
import {
  MAX_PLACEHOLDER_CHARS, missingRequiredPlaceholders, SERVICE_PROMPT_DEFAULTS,
} from '@/shared/service-prompts'

const config = useConfigStore()
const sync = useSyncStore()
const selected = ref('')
const titlePrompt = ref('')
const loading = ref(true)
const saving = ref(false)

/** Only models that can be shown text and answer with text. The rest cannot do this job at all. */
const entries = computed(() => config.enabledModels().filter(entry => canServeAsServiceModel(entry.model.metadata)))

const savedKey = computed(() =>
  sync.settings.service_model ? `${sync.settings.service_model.provider_id}:${sync.settings.service_model.model_id}` : '')
const savedPrompt = computed(() =>
  sync.settings.service_prompts?.conversation_title ?? SERVICE_PROMPT_DEFAULTS.conversation_title)

const missing = computed(() => missingRequiredPlaceholders(titlePrompt.value))
const changed = computed(() => selected.value !== savedKey.value || titlePrompt.value !== savedPrompt.value)

watch(savedKey, value => { selected.value = value; saving.value = false })
watch(savedPrompt, value => { titlePrompt.value = value; saving.value = false })
watch(() => sync.lastError, error => { if (error) saving.value = false })

async function load() {
  loading.value = true
  try {
    if (!config.loaded) await config.load()
    await config.loadEnabledModelList()
    selected.value = savedKey.value
    titlePrompt.value = savedPrompt.value
  }
  catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
  finally { loading.value = false }
}

function save() {
  if (missing.value.length > 0) return
  const separator = selected.value.indexOf(':')
  const service_model = separator < 0 ? null : {
    provider_id: Number(selected.value.slice(0, separator)), model_id: selected.value.slice(separator + 1),
  }
  saving.value = true
  const sent = sync.send({
    type: 'settings.update', request_id: crypto.randomUUID(),
    settings: { service_model, service_prompts: { conversation_title: titlePrompt.value } },
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
    SettingsBackButton
    span.truncate.text-sm.font-medium 服务模型
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 服务模型
        p.text-sm.text-muted-foreground
          | 一个轻量模型，负责你没有主动要求的杂活，比如给对话起名字。挑便宜快的，它的输出很短。
      Card
        CardHeader
          CardTitle.flex.items-center.gap-2
            SparklesIcon
            | 模型
          CardDescription 只列出能读文本也能写文本的模型；生图、生视频模型做不了这些活。
        CardContent
          .flex.items-center.gap-2(v-if="loading")
            Spinner
            span.text-sm.text-muted-foreground 加载中
          FieldGroup(v-else)
            Field
              FieldLabel(for="service-model") 模型
              NativeSelect#service-model(v-model="selected" class="w-full" :disabled="saving")
                NativeSelectOption(value="") 不使用（对话沿用开头文字作为名字）
                NativeSelectOption(
                  v-for="entry in entries" :key="`${entry.provider.id}:${entry.model.model_id}`"
                  :value="`${entry.provider.id}:${entry.model.model_id}`")
                  | {{ entry.provider.name }} · {{ entry.model.metadata.name || entry.model.model_id }}
              FieldDescription(v-if="!entries.length")
                | 还没有可用的模型。先在「模型服务」里启用一个能处理文本的模型。

            Field
              FieldLabel(for="service-title-prompt") 对话命名提示词
              Textarea#service-title-prompt(v-model="titlePrompt" rows="7" class="font-mono text-sm" :disabled="saving")
              FieldDescription
                | 用 {{ '{' }}user_message:1{{ '}' }} 引用对话的第一条消息，最多取前 {{ MAX_PLACEHOLDER_CHARS }} 个字符。
              FieldDescription(v-if="missing.length" class="text-destructive")
                | 必须包含 {{ missing.join('、') }}，否则模型看不到要命名的内容。
        CardFooter.flex.items-center.justify-between.gap-2
          Button(
            type="button" variant="ghost" class="min-h-10"
            :disabled="saving || titlePrompt === SERVICE_PROMPT_DEFAULTS.conversation_title"
            @click="titlePrompt = SERVICE_PROMPT_DEFAULTS.conversation_title") 恢复默认提示词
          Button(type="button" class="min-h-10" :disabled="loading || saving || !changed || missing.length > 0" @click="save")
            | {{ saving ? '保存中' : '保存' }}
</template>
