<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { Badge } from '@/client/ui/badge'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/client/ui/alert-dialog'

const props = defineProps<{ dirty: boolean }>()
const open = ref(false)
let pending: Promise<boolean> | null = null
let finish: ((value: boolean) => void) | null = null

function confirmLeave(): Promise<boolean> {
  if (!props.dirty) return Promise.resolve(true)
  if (pending) return pending
  open.value = true
  pending = new Promise<boolean>(resolve => { finish = resolve })
  return pending
}

function settle(discard: boolean) {
  finish?.(discard)
  finish = null
  pending = null
  open.value = false
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!props.dirty) return
  event.preventDefault()
  event.returnValue = ''
}

onBeforeRouteLeave(confirmLeave)
onBeforeRouteUpdate(confirmLeave)
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload)
  settle(false)
})
defineExpose({ confirmLeave })
</script>

<template lang="pug">
Badge(v-if="dirty" variant="outline" role="status") 未保存的更改
AlertDialog(:open="open" @update:open="value => { if (!value) settle(false) }")
  AlertDialogContent
    AlertDialogHeader
      AlertDialogTitle 放弃未保存的更改？
      AlertDialogDescription 离开后将丢弃尚未保存的内容。你可以继续编辑并保存。
    AlertDialogFooter
      AlertDialogCancel(class="min-h-10" @click="settle(false)") 继续编辑
      AlertDialogAction(variant="destructive" class="min-h-10" @click.capture="settle(true)") 放弃更改
</template>
