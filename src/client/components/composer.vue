<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { ImagePlus, Send, Square, X } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Textarea } from '@/client/ui/textarea'
import { uploadImage } from '@/client/lib/image-prep'
import { mergeRestoredText } from '@/client/stores/sync'
import type { Part } from '@/shared/parts'

interface Attached { attachment_id: number; preview: string; failed?: boolean }

const props = defineProps<{
  streaming: boolean
  connected: boolean
  /** The parent owns model resolution; the Composer only knows whether a send is possible. */
  canSend: boolean
  /** Why sending is blocked, e.g. an inherited model that is no longer available (spec §9). */
  hint?: string | null
}>()
const emit = defineEmits<{ send: [parts: Part[]]; stop: [] }>()

const text = ref('')
const images = ref<Attached[]>([])
// A counter, not a flag: concurrent uploads must not let the first one to finish clear `busy`.
const pending = ref(0)
const busy = computed(() => pending.value > 0)
const fileInput = ref<HTMLInputElement | null>(null)
/**
 * What the last `send` carried. The input clears optimistically so the user can keep typing, but a
 * rejected command must not swallow the message (spec §9), so it is kept here until the parent
 * either sees the message land or sees an error.
 */
const sent = ref<{ text: string; images: Attached[] } | null>(null)

/** Takes a materialised array: a live `FileList` empties out across the `await`s below. */
async function addFiles(files: File[]) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    pending.value++
    try { images.value.push(await uploadImage(f)) }
    catch (err) { console.error(err); images.value.push({ attachment_id: -1, preview: '', failed: true }) }
    finally { pending.value-- }
  }
}
function releasePreviews(items: Attached[]) {
  for (const i of items) if (i.preview) URL.revokeObjectURL(i.preview)
}
function removeImage(index: number) {
  releasePreviews(images.value.splice(index, 1))
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) { e.preventDefault(); void addFiles(files) }
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  void addFiles([...(e.dataTransfer?.files ?? [])])
}
function dropSent() {
  if (sent.value) releasePreviews(sent.value.images)
  sent.value = null
}
function submit() {
  if (busy.value) return
  const parts: Part[] = images.value.filter((i) => !i.failed).map((i) => ({ type: 'image', attachment_id: i.attachment_id }))
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (!parts.length || !props.canSend || !props.connected) return
  emit('send', parts)
  dropSent()
  sent.value = { text: text.value, images: images.value }
  text.value = ''
  images.value = []
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  void addFiles([...(input.files ?? [])])
  input.value = ''
}

/** The command landed: the optimistic clear stands. */
function confirmSend() {
  dropSent()
}
/**
 * The command was rejected: put the message back without losing anything. The rejected message is
 * the earlier one, so it is merged in above whatever the user started typing during the wait
 * (spec §9); an untouched Composer therefore gets it back verbatim. Its images are already stored
 * server-side, so re-attaching their ids costs nothing.
 */
function restoreSend() {
  const previous = sent.value
  sent.value = null
  if (!previous) return
  text.value = mergeRestoredText(previous.text, text.value)
  images.value = [...previous.images, ...images.value]
}
defineExpose({ confirmSend, restoreSend })

onBeforeUnmount(() => { releasePreviews(images.value); dropSent() })
</script>

<template lang="pug">
.border-t.p-3(@drop="onDrop" @dragover.prevent)
  .mx-auto.flex.max-w-3xl.flex-col.gap-2
    .flex.flex-wrap.gap-2(v-if="images.length")
      .relative(v-for="(img, i) in images" :key="i")
        img.h-16.w-16.rounded.object-cover(v-if="!img.failed" :src="img.preview")
        .h-16.w-16.rounded.bg-destructive.text-xs.text-white.flex.items-center.justify-center(v-else) 失败
        button.absolute.rounded-full.bg-background.border(class="-right-1 -top-1" @click="removeImage(i)")
          X(class="size-3")
    Textarea(v-model="text" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片" @keydown="onKeydown" @paste="onPaste")
    //- Spec §7.3: the bottom bar wraps on a narrow screen and nothing here needs hover to operate.
    .flex.flex-wrap.items-center.gap-2
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      Button(variant="ghost" size="icon" title="添加图片" :disabled="busy" @click="fileInput?.click()")
        ImagePlus(class="size-4")
      slot(name="controls")
      .ml-auto.flex.items-center.gap-2
        span.text-xs.text-muted-foreground(v-if="busy") 上传中…
        span.text-xs.text-muted-foreground(v-if="!connected") 未连接
        span.text-xs(v-else-if="hint" class="text-destructive") {{ hint }}
        Button(v-if="streaming" size="sm" variant="destructive" @click="emit('stop')")
          Square(class="size-4")
          span 停止
        Button(v-else size="sm" :disabled="!connected || !canSend || busy" @click="submit")
          Send(class="size-4")
          span 发送
</template>
