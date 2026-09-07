<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Trash2Icon } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { useFormChanges } from '@/client/composables/use-form-changes'
import { catalogSource, createModelDraft, metadataValue, modelWriteFromDraft, resetMetadataOverride, setMetadataOverride, type ModelDraft } from '@/client/lib/model-editor'
import { Button } from '@/client/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Separator } from '@/client/ui/separator'
import { Switch } from '@/client/ui/switch'
import { Textarea } from '@/client/ui/textarea'
import type { ModelWriteInput } from '@/shared/api'
import type { ModelWithMetadata, ProviderInterface } from '@/shared/models'

const props = defineProps<{ open: boolean; providerId: number; model: ModelWithMetadata; interfaces: ProviderInterface[]; defaultInterfaceId: number | null; saving?: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [patch: Partial<ModelWriteInput>]; delete: [] }>()
const form = reactive(createModelDraft(props.model))
let baseline = { ...props.model, ...createModelDraft(props.model) }
const inputs = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})
const prefix = `model-${props.providerId}-${props.model.id}`
type MetadataField = { path: string; label: string; kind: 'text' | 'number' | 'boolean' | 'json' }
const fields = (kind: MetadataField['kind'], labels: Record<string, string>): MetadataField[] => Object.entries(labels).map(([path, label]) => ({ path, label, kind }))
const groups = [
  { label: '基本信息', fields: fields('text', { name: '显示名称', description: '描述', family: '系列' }) },
  { label: '能力', fields: fields('boolean', { attachment: '附件', reasoning: '推理', tool_call: '工具调用', structured_output: '结构化输出', temperature: '可调温度', open_weights: '开放权重' }) },
  { label: '模态', root: 'modalities', fields: fields('json', { 'modalities.input': '输入模态', 'modalities.output': '输出模态' }) },
  { label: '限制', root: 'limit', fields: fields('number', { 'limit.context': '上下文长度', 'limit.input': '输入上限', 'limit.output': '输出上限' }) },
  { label: '价格', root: 'cost', fields: [
    ...fields('number', { 'cost.input': '输入价格', 'cost.output': '输出价格', 'cost.reasoning': '推理价格', 'cost.cache_read': '缓存读取', 'cost.cache_write': '缓存写入', 'cost.input_audio': '音频输入', 'cost.output_audio': '音频输出' }),
    ...fields('json', { 'cost.context_over_200k': '超过 200K 上下文', 'cost.tiers': '价格分层' }),
  ] },
  { label: '推理选项', fields: fields('json', { reasoning_options: '推理选项', interleaved: '交错推理' }) },
  { label: '其他信息', fields: [
    ...fields('text', { knowledge: '知识截止', release_date: '发布日期', last_updated: '更新日期', status: '状态（alpha / beta / deprecated）', license: '许可证' }),
    ...fields('json', { links: '相关链接', weights: '模型权重', benchmarks: '评测结果' }),
  ] },
]
function format(value: unknown): string {
  return value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}
for (const field of groups.flatMap(group => group.fields)) inputs[field.path] = format(metadataValue(form.metadata_override, field.path))
const ownInterfaces = computed(() => props.interfaces.filter(endpoint => endpoint.provider_id === props.model.provider_id))
const defaultInterface = computed(() => ownInterfaces.value.find(endpoint => endpoint.id === props.defaultInterfaceId))
const { dirty, capture, markSaved } = useFormChanges(() => ({ form, inputs }))
function acknowledgeSave(snapshot: string): boolean {
  const submitted = JSON.parse(snapshot) as { form: ModelDraft }
  baseline = { ...baseline, ...submitted.form }
  markSaved(snapshot)
  return capture() === snapshot
}
defineExpose({ captureSnapshot: capture, acknowledgeSave })
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
async function setOpen(next: boolean) {
  if (next || await leaveGuard.value?.confirmLeave()) emit('update:open', next)
}
const valid = computed(() => {
  if (Object.keys(errors).length) return false
  try { modelWriteFromDraft(baseline, form, ownInterfaces.value); return true }
  catch { return false }
})
function reset(path: string) {
  form.metadata_override = resetMetadataOverride(form.metadata_override, path)
  for (const key of Object.keys(inputs)) if (key === path || key.startsWith(`${path}.`)) { inputs[key] = ''; delete errors[key] }
}
function resetGroup(group: typeof groups[number]) {
  if (group.root) reset(group.root)
  else for (const field of group.fields) reset(field.path)
}
function update(field: MetadataField, value: unknown) {
  inputs[field.path] = String(value)
  delete errors[field.path]
  if (value === '') { reset(field.path); return }
  try {
    const parsed = field.kind === 'json' ? JSON.parse(String(value)) : field.kind === 'number' ? Number(value) : value
    form.metadata_override = setMetadataOverride(form.metadata_override, field.path, parsed)
  } catch { errors[field.path] = '请填写符合该字段格式的值。' }
}
function clearCost() {
  reset('cost')
  form.metadata_override = setMetadataOverride(form.metadata_override, 'cost', null)
}
function source(path: string) {
  if (metadataValue(form.metadata_override, path) !== undefined || (path.startsWith('cost.') && form.metadata_override.cost === null)) return '用户覆写'
  return metadataValue(baseline.metadata_override, path) !== undefined ? '继承（保存后恢复目录默认值）' : '继承'
}
function placeholder(path: string) {
  if (metadataValue(baseline.metadata_override, path) !== undefined && metadataValue(form.metadata_override, path) === undefined) return '保存后恢复目录默认值'
  return format(metadataValue(props.model.metadata, path)) || '未提供'
}
function save() {
  if (valid.value && !props.saving) emit('save', modelWriteFromDraft(baseline, form, ownInterfaces.value))
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
        FieldLabel(:for="`${prefix}-interface`") 模型接口
        Select(:model-value="String(form.interface_id ?? 'default')" @update:model-value="form.interface_id = $event === 'default' ? null : Number($event)")
          SelectTrigger(:id="`${prefix}-interface`" class="min-h-10 w-full")
            SelectValue
          SelectContent
            SelectGroup
              SelectItem(value="default") 跟随默认{{ defaultInterface ? ` · ${defaultInterface.protocol}` : '' }}
              SelectItem(v-for="endpoint in ownInterfaces" :key="endpoint.id" :value="String(endpoint.id)") {{ endpoint.protocol }}
        FieldDescription 只能选择此供应商已保存的接口。
      Field(orientation="horizontal" class="min-h-10")
        FieldContent
          FieldLabel(:for="`${prefix}-enabled`") 启用模型
          FieldDescription 在聊天的模型选择器中显示。
        Switch(:id="`${prefix}-enabled`" v-model="form.enabled" class="after:-inset-y-3")
    p.text-sm.text-muted-foreground {{ catalogSource(model) }}
    p.text-sm.text-muted-foreground 留空继承目录值；下方展示当前已保存的有效值。恢复默认将在保存后重新解析。
    FieldSet(v-for="group in groups" :key="group.label")
      FieldLegend(variant="label") {{ group.label }}
      .flex.flex-wrap.gap-2
        Button(type="button" variant="ghost" size="sm" class="min-h-10" :aria-label="`恢复 ${group.label} 整组默认值`" @click="resetGroup(group)") 恢复整组默认
        Button(v-if="group.root === 'cost'" type="button" variant="outline" size="sm" class="min-h-10" aria-label="清除价格" @click="clearCost") 清除价格
      FieldDescription(v-if="group.root === 'cost'") {{ form.metadata_override.cost === null ? '已明确清除价格（null）。' : '价格单位为每百万 token。0 表示免费。' }}
      FieldDescription(v-if="group.label === '模态'") JSON 数组，可使用 text、image、audio、video、pdf。
      FieldDescription(v-if="group.label === '推理选项'") 使用目录结构：toggle、effort（values）或 budget_tokens（min / max）。
      FieldGroup(class="gap-4")
        Field(v-for="field in group.fields" :key="field.path" :data-invalid="!!errors[field.path] || undefined")
          .flex.items-center.justify-between.gap-2
            FieldLabel(:for="`${prefix}-${field.path.replaceAll('.', '-')}`") {{ field.label }}
            Button(type="button" variant="ghost" size="xs" class="min-h-10" :disabled="metadataValue(form.metadata_override, field.path) === undefined && !inputs[field.path] && !errors[field.path]" :aria-label="`恢复 ${field.label} 默认值`" @click="reset(field.path)") 恢复默认
          Switch(v-if="field.kind === 'boolean'" :id="`${prefix}-${field.path}`" :model-value="Boolean(metadataValue(form.metadata_override, field.path) ?? metadataValue(model.metadata, field.path))" class="after:-inset-y-3" @update:model-value="update(field, $event)")
          Textarea(v-else-if="field.kind === 'json'" :id="`${prefix}-${field.path.replaceAll('.', '-')}`" :model-value="inputs[field.path]" :placeholder="placeholder(field.path)" :aria-invalid="!!errors[field.path]" @update:model-value="update(field, $event)")
          Input(v-else :id="`${prefix}-${field.path.replaceAll('.', '-')}`" :model-value="inputs[field.path]" :type="field.kind === 'number' ? 'number' : 'text'" :min="field.kind === 'number' ? 0 : undefined" :step="field.path.startsWith('limit.') ? 1 : 'any'" :placeholder="placeholder(field.path)" :aria-invalid="!!errors[field.path]" class="min-h-10" @update:model-value="update(field, $event)")
          FieldDescription(:data-metadata-source="field.path") {{ source(field.path) }} · 当前有效值：{{ format(metadataValue(model.metadata, field.path)) || '未提供' }}
          FieldDescription(v-if="errors[field.path]" role="alert") {{ errors[field.path] }}
    Separator
    .flex.flex-wrap.items-center.justify-between.gap-2
      Button(type="button" variant="destructive" class="min-h-10" @click="emit('delete')")
        Trash2Icon(data-icon="inline-start")
        | 删除模型
      Button(type="submit" class="min-h-10" :disabled="!valid || saving") {{ saving ? '保存中…' : '保存模型' }}
</template>
