<script setup lang="ts">
import { ref, watch } from 'vue'
import { PlusIcon, XIcon } from '@lucide/vue'
import { buildExtraBody, extraBodyRows, type ExtraBodyRow } from '@/client/lib/extra-body'
import { Button } from '@/client/ui/button'
import { Input } from '@/client/ui/input'
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
function add() { rows.value.push({ key: '', value: '' }) }
function remove(index: number) {
  rows.value.splice(index, 1)
  commit()
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-for="(row, index) in rows" :key="index" class="flex items-center gap-1.5">
      <Input v-model="row.key" :aria-label="`参数 ${index + 1} 名称`" placeholder="名称" class="min-h-9 w-2/5 font-mono text-xs" @update:model-value="commit" />
      <Input v-model="row.value" :aria-label="`参数 ${index + 1} 值`" placeholder="值" class="min-h-9 min-w-0 flex-1 font-mono text-xs" @update:model-value="commit" />
      <Button type="button" size="icon-sm" variant="ghost" :aria-label="`删除参数 ${index + 1}`" @click="remove(index)"><XIcon /></Button>
    </div>
    <Button type="button" size="sm" variant="outline" class="self-start" @click="add"><PlusIcon data-icon="inline-start" />添加参数</Button>
    <p v-if="error" class="text-xs text-destructive" role="alert">{{ error }}</p>
  </div>
</template>
