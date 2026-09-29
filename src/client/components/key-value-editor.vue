<script setup lang="ts" generic="Row extends { key: string; value: string }">
import { PlusIcon, XIcon } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'

/**
 * Rows of name/value inputs, with add, remove and one error line. What a row means — JSON body
 * fields, HTTP headers — and how it is validated belongs to the caller, which also decides what a
 * new row looks like and may add controls at the end of each row.
 */
const rows = defineModel<Row[]>('rows', { required: true })
const props = withDefaults(defineProps<{
  newRow: () => Row
  /** Names the thing a row is, in labels and the add button: 「参数」, 「请求头」. */
  noun?: string
  error?: string | null
  valuePlaceholder?: (row: Row) => string
}>(), { noun: '参数', error: null, valuePlaceholder: undefined })
/** Any edit, add or removal; the caller rebuilds its value from the rows. */
const emit = defineEmits<{ change: [] }>()

function add() {
  rows.value.push(props.newRow())
}
function remove(index: number) {
  rows.value.splice(index, 1)
  emit('change')
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-1.5">
      <Input v-model="row.key" :aria-label="`${noun} ${index + 1} 名称`" placeholder="名称" class="min-h-9 w-2/5 font-mono text-xs" @update:model-value="emit('change')" />
      <Input v-model="row.value" :aria-label="`${noun} ${index + 1} 值`" :placeholder="valuePlaceholder?.(row) ?? '值'" class="min-h-9 min-w-0 flex-1 font-mono text-xs" @update:model-value="emit('change')" />
      <slot name="row-end" :row="row" :index="index" />
      <Button type="button" size="icon-sm" variant="ghost" :aria-label="`删除${noun} ${index + 1}`" @click="remove(index)"><XIcon /></Button>
    </div>
    <Button type="button" size="sm" variant="outline" class="self-start" @click="add"><PlusIcon data-icon="inline-start" />添加{{ noun }}</Button>
    <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
  </div>
</template>
