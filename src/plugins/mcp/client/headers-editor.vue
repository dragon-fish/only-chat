<script setup lang="ts">
import { ref } from 'vue'
import { LockIcon, LockOpenIcon } from '@lucide/vue'
import KeyValueEditor from '@/client/components/key-value-editor.vue'
import { Button } from '@/client/ui/button'
import { isSensitiveHeaderName, mcpHeadersProblem, type McpHeaderInput, type McpHeaderView } from '@/shared/mcp'

interface HeaderRow {
  key: string
  value: string
  secret: boolean
  /** A secret already on the server: left empty, it is kept as it is. */
  saved: boolean
  /** Once the person flips the lock, the name no longer decides it. */
  touched: boolean
}

const props = defineProps<{ initial: readonly McpHeaderView[], oauth: boolean }>()
const headers = defineModel<McpHeaderInput[]>({ required: true })
const error = defineModel<string | null>('error', { default: null })

const rows = ref<HeaderRow[]>(props.initial.map(header => ({
  key: header.name, value: header.value ?? '', secret: header.secret, saved: header.secret && header.value === null, touched: true,
})))

function commit() {
  for (const row of rows.value) {
    if (!row.touched) row.secret = isSensitiveHeaderName(row.key)
  }
  const filled = rows.value.filter(row => row.key.trim() || row.value.trim())
  const unnamed = filled.some(row => !row.key.trim())
  error.value = unnamed ? '有请求头缺少名称。' : mcpHeadersProblem(filled.map(row => ({ name: row.key })), { oauth: props.oauth })
  headers.value = filled.map(row => ({
    name: row.key.trim(),
    value: row.saved && row.value === '' ? null : row.value,
    secret: row.secret,
  }))
}

function toggleSecret(row: HeaderRow) {
  row.touched = true
  row.secret = !row.secret
  // A saved secret has no plaintext here; turning it plain means typing the value again.
  if (!row.secret) row.saved = false
  commit()
}

const placeholder = (row: HeaderRow) => (row.saved ? '已保存，输入新值以替换' : row.secret ? '值（加密保存，不再显示）' : '值')
const newRow = (): HeaderRow => ({ key: '', value: '', secret: false, saved: false, touched: false })
</script>

<template lang="pug">
KeyValueEditor(v-model:rows="rows" :new-row="newRow" noun="请求头" :error="error" :value-placeholder="placeholder" @change="commit")
  template(#row-end="{ row }")
    Button(
      type="button" size="icon-sm" variant="ghost" :aria-pressed="row.secret"
      :aria-label="row.secret ? '敏感：加密保存，点击改为明文' : '明文保存，点击改为敏感'"
      :title="row.secret ? '敏感：加密保存，保存后不再显示' : '明文保存'"
      @click="toggleSecret(row)")
      LockIcon(v-if="row.secret")
      LockOpenIcon(v-else class="text-muted-foreground")
</template>
