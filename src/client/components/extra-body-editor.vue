<script setup lang="ts">
import { ref, watch } from 'vue'
import KeyValueEditor from '@/client/components/key-value-editor.vue'
import { buildExtraBody, extraBodyRows, type ExtraBodyRow } from '@/client/lib/extra-body'
import type { ImageExtraBody } from '@/shared/artifacts'

const body = defineModel<ImageExtraBody>({ required: true })
/** The rows as typed cannot be sent; the parent must not save or submit until this clears. */
const error = defineModel<string | null>('error', { default: null })
const rows = ref<ExtraBodyRow[]>(extraBodyRows(body.value))

// Rows are the source of truth while typing; only an outside change (a restored run, a reset)
// replaces them. The model only moves on a valid build, so an invalid row never echoes back here.
watch(body, (next) => {
  const built = buildExtraBody(rows.value)
  if (!('body' in built) || JSON.stringify(built.body) !== JSON.stringify(next)) {
    rows.value = extraBodyRows(next)
    error.value = null
  }
})

function commit() {
  const built = buildExtraBody(rows.value)
  if ('error' in built) { error.value = built.error; return }
  error.value = null
  if (JSON.stringify(built.body) !== JSON.stringify(body.value)) body.value = built.body
}
</script>

<template>
  <KeyValueEditor v-model:rows="rows" :new-row="() => ({ key: '', value: '' })" noun="参数" :error="error" @change="commit" />
</template>

