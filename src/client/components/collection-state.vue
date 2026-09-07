<script setup lang="ts">
import { ref } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Skeleton } from '@/client/ui/skeleton'

const props = defineProps<{
  loaded: boolean
  error?: string | null
  empty?: boolean
  emptyTitle?: string
  emptyDescription?: string
  retry?: () => Promise<unknown>
}>()
const retrying = ref(false)
async function retry() {
  retrying.value = true
  try { await props.retry?.() }
  catch { /* The collection owner retains the error for this Alert. */ }
  finally { retrying.value = false }
}
</script>

<template lang="pug">
Alert(v-if="error" variant="destructive")
  AlertTitle 加载失败
  AlertDescription(class="break-words")
    p {{ error }}
    Button(v-if="props.retry" variant="outline" class="min-h-10 mt-2" :disabled="retrying" @click="retry") 重试
.flex.flex-col.gap-2(v-else-if="!loaded" role="status" aria-label="正在加载")
  Skeleton(v-for="index in 3" :key="index" class="h-12 w-full")
  span.sr-only 加载中…
Empty(v-else-if="empty")
  EmptyHeader
    EmptyTitle {{ emptyTitle }}
    EmptyDescription(v-if="emptyDescription") {{ emptyDescription }}
  EmptyContent(v-if="$slots['empty-action']")
    slot(name="empty-action")
slot(v-else)
</template>
