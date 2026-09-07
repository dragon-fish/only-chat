<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Trash2Icon } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { modelCapabilitiesWithEfforts } from '@/client/lib/settings'
import { REASONING_LABELS } from '@/client/stores/sync'
import { Button } from '@/client/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Separator } from '@/client/ui/separator'
import { Switch } from '@/client/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { ModelInput } from '@/shared/api'
import { ReasoningEffortSchema, type Model, type ModelCapabilities } from '@/shared/models'

const props = defineProps<{ open: boolean; providerId: number; model: Model; saving?: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [patch: Partial<ModelInput>]; delete: [] }>()
const form = reactive({
  model_id: props.model.model_id,
  display_name: props.model.display_name,
  enabled: props.model.enabled,
  capabilities: { ...props.model.capabilities } as ModelCapabilities,
})
const prefix = `model-${props.providerId}-${props.model.id}`
const { dirty, capture, markSaved } = useFormChanges(() => form)
function acknowledgeSave(snapshot: string): boolean {
  markSaved(snapshot)
  return capture() === snapshot
}
defineExpose({ captureSnapshot: capture, acknowledgeSave })
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
async function setOpen(next: boolean) {
  if (next || await leaveGuard.value?.confirmLeave()) emit('update:open', next)
}
const valid = computed(() => !!form.model_id.trim() && !!form.display_name.trim())
const flags = [
  { key: 'vision', label: '视觉', description: '理解图片输入' },
  { key: 'reasoning', label: '推理', description: '支持深度思考' },
  { key: 'tools', label: '工具调用', description: '使用聊天中启用的工具' },
  { key: 'image_output', label: '图片输出', description: '生成图片' },
  { key: 'reasoning_can_disable', label: '可关闭推理', description: '允许显式关闭思考' },
] as const

function onEfforts(value: unknown) {
  const parsed = ReasoningEffortSchema.array().safeParse(value)
  if (parsed.success) form.capabilities = modelCapabilitiesWithEfforts(form.capabilities, parsed.data)
}

function save() {
  if (!valid.value || props.saving) return
  emit('save', {
    model_id: form.model_id.trim(), display_name: form.display_name.trim(), enabled: form.enabled,
    capabilities: modelCapabilitiesWithEfforts(form.capabilities, form.capabilities.reasoning_efforts ?? []),
  })
}
</script>

<template lang="pug">
ResponsiveOverlay(:open="open" title="编辑模型" @update:open="setOpen")
  form.flex.flex-col.gap-6(@submit.prevent="save")
    UnsavedChangesGuard(ref="leaveGuard" :dirty="dirty")
    FieldGroup
      Field
        FieldLabel(:for="`${prefix}-id`") 模型 ID
        Input(:id="`${prefix}-id`" v-model="form.model_id" required class="min-h-10")
        FieldDescription 供应商 API 使用的模型标识。
      Field
        FieldLabel(:for="`${prefix}-name`") 显示名称
        Input(:id="`${prefix}-name`" v-model="form.display_name" required class="min-h-10")
      Field(orientation="horizontal" class="min-h-10")
        FieldContent
          FieldLabel(:for="`${prefix}-enabled`") 启用模型
          FieldDescription 在聊天的模型选择器中显示。
        Switch(:id="`${prefix}-enabled`" v-model="form.enabled" class="after:-inset-y-3")
      FieldSet
        FieldLegend(variant="label") 模型能力
        FieldDescription 按供应商实际支持的能力声明。
        FieldGroup(class="gap-3")
          Field(v-for="flag in flags" :key="flag.key" orientation="horizontal" class="min-h-10")
            FieldContent
              FieldLabel(:for="`${prefix}-${flag.key}`") {{ flag.label }}
              FieldDescription {{ flag.description }}
            Switch(:id="`${prefix}-${flag.key}`" :model-value="!!form.capabilities[flag.key]" class="after:-inset-y-3" @update:model-value="form.capabilities[flag.key] = $event")
      Field
        FieldLabel(:id="`${prefix}-efforts`") 推理档位
        ToggleGroup(type="multiple" variant="outline" :spacing="1" class="flex-wrap" :aria-labelledby="`${prefix}-efforts`" :model-value="form.capabilities.reasoning_efforts ?? []" @update:model-value="onEfforts")
          ToggleGroupItem(v-for="effort in ReasoningEffortSchema.options" :key="effort" :value="effort" class="min-h-10 min-w-10") {{ REASONING_LABELS[effort] }}
        FieldDescription 留空表示未声明，不限制可用的推理档位。
    Separator
    .flex.flex-wrap.items-center.justify-between.gap-2
      Button(type="button" variant="destructive" class="min-h-10" @click="emit('delete')")
        Trash2Icon(data-icon="inline-start")
        | 删除模型
      Button(type="submit" class="min-h-10" :disabled="!valid || saving") {{ saving ? '保存中…' : '保存模型' }}
</template>
