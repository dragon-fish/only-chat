<script setup lang="ts">
import { CheckIcon } from '@lucide/vue'
import { Badge } from '@/client/ui/badge'
import { Checkbox } from '@/client/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import SecretRowsEditor from '@/client/components/secret-rows-editor.vue'
import type { PluginConfigControl } from '@/client/lib/plugin-config-form'
import type { KeyValueEntryView } from '@/shared/key-value'

const props = defineProps<{
  controls: readonly PluginConfigControl[]
  modelValue: Record<string, unknown>
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [values: Record<string, unknown>] }>()

function set(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

/**
 * Narrowing belongs here, not in the template: Vue compiles template expressions as JavaScript, so
 * a TypeScript `as` there is a runtime SyntaxError that takes the whole route component down.
 */
function inputValue(key: string): string | number {
  const value = props.modelValue[key]
  return typeof value === 'number' ? value : String(value ?? '')
}

function rowsOf(value: unknown): KeyValueEntryView[] {
  return Array.isArray(value) ? value as KeyValueEntryView[] : []
}

/** Rows are seeded once per stored state; a save that changes it remounts them with the new locks. */
function rowsKey(control: PluginConfigControl): string {
  return `${control.key}:${JSON.stringify(control.value ?? [])}`
}
</script>

<template lang="pug">
.flex.flex-col.gap-5
  Field(v-for="control in controls" :key="control.key")
    FieldLabel.flex.items-center.gap-2(:for="`plugin-config-${control.key}`")
      span {{ control.label }}
      Badge(v-if="control.type === 'secret' && control.configured" variant="secondary")
        CheckIcon(class="size-3")
        | 已配置
    NativeSelect(
      v-if="control.type === 'select'" :id="`plugin-config-${control.key}`"
      :model-value="String(modelValue[control.key] ?? '')" :disabled="disabled" class="w-full"
      @update:model-value="set(control.key, $event)")
      NativeSelectOption(v-for="option in control.options" :key="option" :value="option") {{ option }}
    SecretRowsEditor(
      v-else-if="control.type === 'key_value'" :key="rowsKey(control)" :initial="rowsOf(control.value)" :noun="control.label"
      :model-value="rowsOf(modelValue[control.key])" @update:model-value="set(control.key, $event)")
    .flex.items-center.gap-2(v-else-if="control.type === 'boolean'")
      Checkbox(
        :id="`plugin-config-${control.key}`" :model-value="modelValue[control.key] === true"
        :disabled="disabled" @update:model-value="set(control.key, $event === true)")
    Input(
      v-else :id="`plugin-config-${control.key}`"
      :type="control.type === 'secret' ? 'password' : control.type === 'number' ? 'number' : 'text'"
      :model-value="inputValue(control.key)"
      :min="control.min" :max="control.max" :disabled="disabled"
      :autocomplete="control.type === 'secret' ? 'new-password' : undefined"
      :placeholder="control.type === 'secret' && control.configured ? '留空则保持不变' : control.placeholder"
      @update:model-value="set(control.key, $event)")
    FieldDescription {{ control.help }}
</template>
