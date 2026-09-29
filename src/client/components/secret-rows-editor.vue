<script setup lang="ts">
import { ref } from 'vue'
import { LockIcon, LockOpenIcon } from '@lucide/vue'
import KeyValueEditor from '@/client/components/key-value-editor.vue'
import { Button } from '@/client/ui/button'
import { isSensitiveName, type KeyValueEntryView } from '@/shared/key-value'

interface Row {
  key: string
  value: string
  secret: boolean
  /** A secret already on the server: left empty, it is kept as it is. */
  saved: boolean
  /** Once the person flips the lock, the name no longer decides it. */
  touched: boolean
}

/**
 * Name/value rows each with a lock: a locked value is stored encrypted and never shown again. The
 * name suggests the lock until the person sets it. What the rows are for, and what makes a set of
 * them invalid, belongs to the caller.
 */
const props = withDefaults(defineProps<{
  initial: readonly KeyValueEntryView[]
  noun?: string
  validate?: (rows: readonly KeyValueEntryView[]) => string | null
}>(), { noun: '请求头', validate: undefined })
const entries = defineModel<KeyValueEntryView[]>({ required: true })
const error = defineModel<string | null>('error', { default: null })

const rows = ref<Row[]>(props.initial.map(entry => ({
  key: entry.name, value: entry.value ?? '', secret: entry.secret, saved: entry.secret && entry.value === null, touched: true,
})))

function commit() {
  for (const row of rows.value) {
    if (!row.touched) row.secret = isSensitiveName(row.key)
  }
  const filled = rows.value.filter(row => row.key.trim() || row.value.trim())
  entries.value = filled.map(row => ({
    name: row.key.trim(),
    value: row.saved && row.value === '' ? null : row.value,
    secret: row.secret,
  }))
  error.value = filled.some(row => !row.key.trim()) ? `有${props.noun}缺少名称。` : props.validate?.(entries.value) ?? null
}

function toggleSecret(row: Row) {
  row.touched = true
  row.secret = !row.secret
  // A saved secret has no plaintext here; turning it plain means typing the value again.
  if (!row.secret) row.saved = false
  commit()
}

const placeholder = (row: Row) => (row.saved ? '已保存，输入新值以替换' : row.secret ? '值（加密保存，不再显示）' : '值')
const newRow = (): Row => ({ key: '', value: '', secret: false, saved: false, touched: false })
</script>

<template lang="pug">
KeyValueEditor(v-model:rows="rows" :new-row="newRow" :noun="noun" :error="error" :value-placeholder="placeholder" @change="commit")
  template(#row-end="{ row }")
    Button(
      type="button" size="icon-sm" variant="ghost" :aria-pressed="row.secret"
      :aria-label="row.secret ? '敏感：加密保存，点击改为明文' : '明文保存，点击改为敏感'"
      :title="row.secret ? '敏感：加密保存，保存后不再显示' : '明文保存'"
      @click="toggleSecret(row)")
      LockIcon(v-if="row.secret")
      LockOpenIcon(v-else class="text-muted-foreground")
</template>
