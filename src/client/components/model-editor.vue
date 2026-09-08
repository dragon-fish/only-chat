<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { BracesIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import UnsavedChangesGuard from '@/client/components/unsaved-changes-guard.vue'
import { catalogSource, metadataValue, resetMetadataOverride, setMetadataOverride, type ModelEditorSession } from '@/client/lib/model-editor'
import { Button } from '@/client/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Checkbox } from '@/client/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/client/ui/select'
import { Separator } from '@/client/ui/separator'
import { Switch } from '@/client/ui/switch'
import { Textarea } from '@/client/ui/textarea'
import type { ModelWriteInput } from '@/shared/api'
import {
  ModelMetadataOverrideSchema,
  type ModelMetadataOverride,
  type ModelModality,
  type ReasoningOption,
} from '@/shared/model-metadata'
import type { ProviderInterface } from '@/shared/models'

const props = defineProps<{ open: boolean; session: ModelEditorSession; interfaces: ProviderInterface[]; defaultInterfaceId: number | null; saving?: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; save: [patch: Partial<ModelWriteInput>]; delete: [] }>()
const form = props.session.form
const model = computed(() => props.session.model)
const inputs = reactive<Record<string, string>>({})
const errors = reactive<Record<string, string>>({})
const rawOpen = ref(false)
const rawInput = ref('')
const prefix = `model-${props.session.target.provider_id}-${props.session.target.id}`
type MetadataField = { path: string; label: string; kind: 'text' | 'number' | 'boolean' }
const fields = (kind: MetadataField['kind'], labels: Record<string, string>): MetadataField[] => Object.entries(labels).map(([path, label]) => ({ path, label, kind }))
const groups = [
  { label: '基本信息', fields: fields('text', { name: '显示名称', description: '描述', family: '系列' }) },
  { label: '能力', fields: fields('boolean', { attachment: '附件', reasoning: '推理', tool_call: '工具调用', structured_output: '结构化输出', temperature: '可调温度', open_weights: '开放权重' }) },
  { label: '限制', root: 'limit', fields: fields('number', { 'limit.context': '上下文长度', 'limit.input': '输入上限', 'limit.output': '输出上限' }) },
  { label: '价格', root: 'cost', fields: fields('number', { 'cost.input': '输入价格', 'cost.output': '输出价格', 'cost.reasoning': '推理价格', 'cost.cache_read': '缓存读取', 'cost.cache_write': '缓存写入', 'cost.input_audio': '音频输入', 'cost.output_audio': '音频输出' }) },
  { label: '其他信息', fields: fields('text', { knowledge: '知识截止', release_date: '发布日期', last_updated: '更新日期', status: '状态（alpha / beta / deprecated）', license: '许可证' }) },
]
const modalities = ['text', 'image', 'audio', 'video', 'pdf'] as const satisfies readonly ModelModality[]
const effortValues = [null, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default'] as const
type EffortValue = typeof effortValues[number]
function format(value: unknown): string {
  return value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}
function syncInputs() {
  for (const field of groups.flatMap(group => group.fields)) inputs[field.path] = format(metadataValue(form.metadata_override, field.path))
}
syncInputs()
function effectiveValue(path: string) {
  return metadataValue(form.metadata_override, path) ?? metadataValue(model.value.metadata, path)
}
function effectiveModalities(kind: 'input' | 'output'): ModelModality[] {
  const value = effectiveValue(`modalities.${kind}`)
  return Array.isArray(value) ? value.filter((item): item is ModelModality => modalities.includes(item as ModelModality)) : []
}
function toggleModality(kind: 'input' | 'output', modality: ModelModality, checked: boolean) {
  const selected = new Set(effectiveModalities(kind))
  if (checked) selected.add(modality)
  else selected.delete(modality)
  form.metadata_override = setMetadataOverride(form.metadata_override, `modalities.${kind}`, modalities.filter(item => selected.has(item)))
}
function reasoningOptions(): ReasoningOption[] {
  const value = effectiveValue('reasoning_options')
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) as ReasoningOption[] : []
}
function commitReasoningOptions(options: ReasoningOption[]) {
  try {
    form.metadata_override = setMetadataOverride(form.metadata_override, 'reasoning_options', options)
    delete errors.reasoning_options
  } catch {
    errors.reasoning_options = '推理 Token 预算的最小值不能大于最大值。'
  }
}
function hasReasoningToggle() {
  return reasoningOptions().some(option => option.type === 'toggle')
}
function toggleReasoningToggle(checked: boolean) {
  const options: ReasoningOption[] = reasoningOptions().filter(option => option.type !== 'toggle')
  if (checked) options.unshift({ type: 'toggle' })
  commitReasoningOptions(options)
}
function selectedEfforts(): EffortValue[] {
  return reasoningOptions().find(option => option.type === 'effort')?.values ?? []
}
function effortLabel(value: EffortValue) {
  if (value === null) return '自动（null）'
  return value === 'default' ? '默认' : value
}
function toggleEffort(value: EffortValue, checked: boolean) {
  const options: ReasoningOption[] = reasoningOptions().filter(option => option.type !== 'effort')
  const selected = selectedEfforts().filter(item => item !== value)
  if (checked) selected.push(value)
  if (selected.length) options.push({ type: 'effort', values: selected })
  commitReasoningOptions(options)
}
function reasoningBudget() {
  return reasoningOptions().find(option => option.type === 'budget_tokens')
}
const budgetMin = ref(format(reasoningBudget()?.min))
const budgetMax = ref(format(reasoningBudget()?.max))
function toggleReasoningBudget(checked: boolean) {
  const options: ReasoningOption[] = reasoningOptions().filter(option => option.type !== 'budget_tokens')
  if (checked) options.push({ type: 'budget_tokens' })
  commitReasoningOptions(options)
}
function updateReasoningBudget(key: 'min' | 'max', value: string | number) {
  if (key === 'min') budgetMin.value = String(value)
  else budgetMax.value = String(value)
  const options: ReasoningOption[] = reasoningOptions().filter(option => option.type !== 'budget_tokens')
  const budget: Extract<ReasoningOption, { type: 'budget_tokens' }> = { type: 'budget_tokens' }
  if (budgetMin.value !== '') budget.min = Number(budgetMin.value)
  if (budgetMax.value !== '') budget.max = Number(budgetMax.value)
  options.push(budget)
  commitReasoningOptions(options)
}
function resetReasoningOptions() {
  reset('reasoning_options')
  budgetMin.value = ''
  budgetMax.value = ''
  delete errors.reasoning_options
}
function interleavedMode(): 'inherit' | 'disabled' | 'automatic' | 'field' {
  const value = metadataValue(form.metadata_override, 'interleaved')
  if (value === undefined) return 'inherit'
  if (value === false) return 'disabled'
  if (value === true) return 'automatic'
  return 'field'
}
const interleavedField = ref(typeof effectiveValue('interleaved') === 'object' ? String((effectiveValue('interleaved') as { field?: unknown }).field ?? '') : '')
function setInterleavedMode(value: unknown) {
  if (value === 'inherit') reset('interleaved')
  else if (value === 'disabled') form.metadata_override = setMetadataOverride(form.metadata_override, 'interleaved', false)
  else if (value === 'automatic') form.metadata_override = setMetadataOverride(form.metadata_override, 'interleaved', true)
  else if (value === 'field') form.metadata_override = setMetadataOverride(form.metadata_override, 'interleaved', { field: interleavedField.value || 'reasoning_content' })
}
function updateInterleavedField(value: string | number) {
  interleavedField.value = String(value)
  if (interleavedMode() === 'field') form.metadata_override = setMetadataOverride(form.metadata_override, 'interleaved', { field: interleavedField.value })
}
function toggleRawEditor() {
  if (!rawOpen.value) rawInput.value = format(form.metadata_override)
  rawOpen.value = !rawOpen.value
}
function updateRaw(value: string | number) {
  rawInput.value = String(value)
  delete errors.raw
  let parsed: unknown
  try { parsed = JSON.parse(rawInput.value) }
  catch { errors.raw = 'JSON 语法错误，请检查括号、引号和逗号。'; return }
  const result = ModelMetadataOverrideSchema.safeParse(parsed)
  if (!result.success) { errors.raw = '内容不符合模型元数据结构，请检查字段名称和值的类型。'; return }
  form.metadata_override = result.data as ModelMetadataOverride
  syncInputs()
  budgetMin.value = format(reasoningBudget()?.min)
  budgetMax.value = format(reasoningBudget()?.max)
  interleavedField.value = typeof effectiveValue('interleaved') === 'object' ? String((effectiveValue('interleaved') as { field?: unknown }).field ?? '') : ''
}
const ownInterfaces = computed(() => props.interfaces.filter(endpoint => endpoint.provider_id === props.session.target.provider_id))
const defaultInterface = computed(() => ownInterfaces.value.find(endpoint => endpoint.id === props.defaultInterfaceId))
const dirty = computed(() => props.session.dirty || Object.keys(errors).length > 0)
const capture = () => JSON.stringify({ form, inputs, rawInput: rawInput.value })
defineExpose({ captureSnapshot: capture, matchesSnapshot: (snapshot: string) => capture() === snapshot && !dirty.value })
const leaveGuard = ref<InstanceType<typeof UnsavedChangesGuard> | null>(null)
async function setOpen(next: boolean) {
  if (next || await leaveGuard.value?.confirmLeave()) emit('update:open', next)
}
const valid = computed(() => {
  if (Object.keys(errors).length) return false
  try { props.session.patch(ownInterfaces.value); return true }
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
    const parsed = field.kind === 'number' ? Number(value) : value
    form.metadata_override = setMetadataOverride(form.metadata_override, field.path, parsed)
  } catch { errors[field.path] = '请填写符合该字段格式的值。' }
}
function clearCost() {
  reset('cost')
  form.metadata_override = setMetadataOverride(form.metadata_override, 'cost', null)
}
function source(path: string) {
  if (metadataValue(form.metadata_override, path) !== undefined || (path.startsWith('cost.') && form.metadata_override.cost === null)) return '用户覆写'
  return metadataValue(model.value.metadata_override, path) !== undefined ? '继承（保存后恢复目录默认值）' : '继承'
}
function placeholder(path: string) {
  if (metadataValue(model.value.metadata_override, path) !== undefined && metadataValue(form.metadata_override, path) === undefined) return '保存后恢复目录默认值'
  return format(metadataValue(model.value.metadata, path)) || '未提供'
}
function save() {
  if (valid.value && !props.saving) emit('save', props.session.patch(ownInterfaces.value))
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
    Button(type="button" variant="outline" class="min-h-10 self-start" aria-label="查看或编辑原始 JSON" :disabled="rawOpen && !!errors.raw" @click="toggleRawEditor")
      BracesIcon(data-icon="inline-start")
      | {{ rawOpen ? '返回结构化表单' : '查看或编辑原始 JSON' }}
    template(v-if="rawOpen")
      Alert
        TriangleAlertIcon
        AlertTitle 高级设置
        AlertDescription 保存错误的数据可能导致意外问题。这里只编辑用户覆写；缺少的字段仍继承 models.dev。保存前会检查 JSON 语法和基础数据结构。
      Field(:data-invalid="!!errors.raw || undefined")
        FieldLabel(:for="`${prefix}-raw-json`") 用户覆写 JSON
        Textarea(:id="`${prefix}-raw-json`" :model-value="rawInput" :aria-invalid="!!errors.raw" class="min-h-64 font-mono" @update:model-value="updateRaw")
        FieldDescription(v-if="errors.raw" data-raw-json-error role="alert") {{ errors.raw }}
      Field
        FieldLabel(:for="`${prefix}-effective-json`") 当前有效元数据（只读）
        Textarea(:id="`${prefix}-effective-json`" :model-value="format(model.metadata)" readonly class="min-h-48 font-mono")
    template(v-else)
      FieldSet
        FieldLegend(variant="label") 模态
        .flex.flex-wrap.gap-2
          Button(type="button" variant="ghost" size="sm" class="min-h-10" aria-label="恢复 模态 整组默认值" @click="reset('modalities')") 恢复整组默认
        FieldDescription 选择模型可以接收和生成的内容类型。
        FieldGroup(class="gap-4")
          FieldSet
            FieldLegend(variant="label") 输入模态
            FieldGroup(class="grid grid-cols-2 gap-3 sm:grid-cols-3")
              Field(v-for="modality in modalities" :key="`input-${modality}`" orientation="horizontal")
                Checkbox(:id="`${prefix}-input-${modality}`" :aria-label="`输入模态 ${modality}`" :model-value="effectiveModalities('input').includes(modality)" @update:model-value="toggleModality('input', modality, $event === true)")
                FieldLabel(:for="`${prefix}-input-${modality}`" class="font-normal") {{ modality }}
          FieldSet
            FieldLegend(variant="label") 输出模态
            FieldGroup(class="grid grid-cols-2 gap-3 sm:grid-cols-3")
              Field(v-for="modality in modalities" :key="`output-${modality}`" orientation="horizontal")
                Checkbox(:id="`${prefix}-output-${modality}`" :aria-label="`输出模态 ${modality}`" :model-value="effectiveModalities('output').includes(modality)" @update:model-value="toggleModality('output', modality, $event === true)")
                FieldLabel(:for="`${prefix}-output-${modality}`" class="font-normal") {{ modality }}
      FieldSet(:data-invalid="!!errors.reasoning_options || undefined")
        FieldLegend(variant="label") 推理选项
        .flex.flex-wrap.gap-2
          Button(type="button" variant="ghost" size="sm" class="min-h-10" aria-label="恢复 推理选项 整组默认值" @click="resetReasoningOptions") 恢复推理选项
          Button(type="button" variant="ghost" size="sm" class="min-h-10" aria-label="恢复 交错推理 默认值" @click="reset('interleaved')") 恢复交错推理
        FieldGroup(class="gap-4")
          Field(orientation="horizontal" class="min-h-10")
            FieldContent
              FieldLabel(:for="`${prefix}-reasoning-toggle`") 允许关闭思考
              FieldDescription 请求可以显式关闭推理。
            Switch(:id="`${prefix}-reasoning-toggle`" aria-label="支持思考开关" :model-value="hasReasoningToggle()" class="after:-inset-y-3" @update:model-value="toggleReasoningToggle")
          FieldSet
            FieldLegend(variant="label") 支持的思考强度
            FieldGroup(class="grid grid-cols-2 gap-3 sm:grid-cols-3")
              Field(v-for="effort in effortValues" :key="String(effort)" orientation="horizontal")
                Checkbox(:id="`${prefix}-effort-${String(effort)}`" :aria-label="`推理强度 ${String(effort)}`" :model-value="selectedEfforts().includes(effort)" @update:model-value="toggleEffort(effort, $event === true)")
                FieldLabel(:for="`${prefix}-effort-${String(effort)}`" class="font-normal") {{ effortLabel(effort) }}
          Field(orientation="horizontal" class="min-h-10")
            FieldContent
              FieldLabel(:for="`${prefix}-reasoning-budget`") Token 预算
              FieldDescription 供应商支持按 Token 数量控制推理时启用。
            Switch(:id="`${prefix}-reasoning-budget`" aria-label="启用推理 Token 预算" :model-value="!!reasoningBudget()" class="after:-inset-y-3" @update:model-value="toggleReasoningBudget")
          FieldGroup(v-if="reasoningBudget()" class="grid gap-4 sm:grid-cols-2")
            Field(:data-invalid="!!errors.reasoning_options || undefined")
              FieldLabel(:for="`${prefix}-reasoning-budget-min`") 最小 Token
              Input(:id="`${prefix}-reasoning-budget-min`" :model-value="budgetMin" type="number" min="-1" step="1" :aria-invalid="!!errors.reasoning_options" class="min-h-10" @update:model-value="updateReasoningBudget('min', $event)")
            Field(:data-invalid="!!errors.reasoning_options || undefined")
              FieldLabel(:for="`${prefix}-reasoning-budget-max`") 最大 Token
              Input(:id="`${prefix}-reasoning-budget-max`" :model-value="budgetMax" type="number" min="0" step="1" :aria-invalid="!!errors.reasoning_options" class="min-h-10" @update:model-value="updateReasoningBudget('max', $event)")
          FieldDescription(v-if="errors.reasoning_options" role="alert") {{ errors.reasoning_options }}
          Field
            FieldLabel(:for="`${prefix}-interleaved`") 交错推理
            Select(:model-value="interleavedMode()" @update:model-value="setInterleavedMode")
              SelectTrigger(:id="`${prefix}-interleaved`" class="min-h-10 w-full")
                SelectValue
              SelectContent
                SelectGroup
                  SelectItem(value="inherit") 继承目录默认值
                  SelectItem(value="disabled") 不支持
                  SelectItem(value="automatic") 自动处理
                  SelectItem(value="field") 指定响应字段
            FieldDescription 控制工具调用之间如何保存和回传完整思维链。
          Field(v-if="interleavedMode() === 'field'")
            FieldLabel(:for="`${prefix}-interleaved-field`") 响应字段
            Input(:id="`${prefix}-interleaved-field`" :model-value="interleavedField" required class="min-h-10" @update:model-value="updateInterleavedField")
      FieldSet(v-for="group in groups" :key="group.label")
        FieldLegend(variant="label") {{ group.label }}
        .flex.flex-wrap.gap-2
          Button(type="button" variant="ghost" size="sm" class="min-h-10" :aria-label="`恢复 ${group.label} 整组默认值`" @click="resetGroup(group)") 恢复整组默认
          Button(v-if="group.root === 'cost'" type="button" variant="outline" size="sm" class="min-h-10" aria-label="清除价格" @click="clearCost") 清除价格
        FieldDescription(v-if="group.root === 'cost'") {{ form.metadata_override.cost === null ? '已明确清除价格（null）。' : '价格单位为每百万 token。0 表示免费；分层价格可在原始 JSON 中覆写。' }}
        FieldGroup(class="gap-4")
          Field(v-for="field in group.fields" :key="field.path" :data-invalid="!!errors[field.path] || undefined")
            .flex.items-center.justify-between.gap-2
              FieldLabel(:for="`${prefix}-${field.path.replaceAll('.', '-')}`") {{ field.label }}
              Button(type="button" variant="ghost" size="xs" class="min-h-10" :disabled="metadataValue(form.metadata_override, field.path) === undefined && !inputs[field.path] && !errors[field.path]" :aria-label="`恢复 ${field.label} 默认值`" @click="reset(field.path)") 恢复默认
            Switch(v-if="field.kind === 'boolean'" :id="`${prefix}-${field.path}`" :model-value="Boolean(metadataValue(form.metadata_override, field.path) ?? metadataValue(model.metadata, field.path))" class="after:-inset-y-3" @update:model-value="update(field, $event)")
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
