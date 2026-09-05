<script setup lang="ts">
import { ref } from 'vue'
import { ImagePlus, Send, Square, X } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import { Textarea } from '@/client/ui/textarea'
import ModelPicker from '@/client/components/model-picker.vue'
import { uploadImage } from '@/client/lib/image-prep'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'

const props = defineProps<{ streaming: boolean; connected: boolean; model: ModelRef | null }>()
const emit = defineEmits<{ send: [parts: Part[]]; stop: []; 'update:model': [ModelRef | null] }>()

const text = ref('')
const images = ref<Array<{ attachment_id: number; preview: string; failed?: boolean }>>([])
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

async function addFiles(files: Iterable<File>) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    busy.value = true
    try { images.value.push(await uploadImage(f)) }
    catch (err) { console.error(err); images.value.push({ attachment_id: -1, preview: '', failed: true }) }
    finally { busy.value = false }
  }
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) { e.preventDefault(); void addFiles(files) }
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  void addFiles(e.dataTransfer?.files ?? [])
}
function submit() {
  const parts: Part[] = images.value.filter((i) => !i.failed).map((i) => ({ type: 'image', attachment_id: i.attachment_id }))
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (!parts.length || !props.model || !props.connected) return
  emit('send', parts)
  text.value = ''
  images.value = []
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  void addFiles(input.files ?? [])
  input.value = ''
}
function onModelChange(value: ModelRef | null) {
  emit('update:model', value)
}
</script>

<template lang="pug">
.border-t.p-3(@drop="onDrop" @dragover.prevent)
  .mx-auto.flex.max-w-3xl.flex-col.gap-2
    .flex.flex-wrap.gap-2(v-if="images.length")
      .relative(v-for="(img, i) in images" :key="i")
        img.h-16.w-16.rounded.object-cover(v-if="!img.failed" :src="img.preview")
        .h-16.w-16.rounded.bg-destructive.text-xs.text-white.flex.items-center.justify-center(v-else) 失败
        button.absolute.rounded-full.bg-background.border(class="-right-1 -top-1" @click="images.splice(i, 1)")
          X(class="size-3")
    Textarea(v-model="text" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行，可粘贴图片" @keydown="onKeydown" @paste="onPaste")
    .flex.items-center.gap-2
      ModelPicker(:model-value="model" @update:model-value="onModelChange")
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      Button(variant="ghost" size="icon" :disabled="busy" @click="fileInput?.click()")
        ImagePlus(class="size-4")
      .ml-auto.flex.items-center.gap-2
        span.text-xs.text-muted-foreground(v-if="!connected") 未连接
        Button(v-if="streaming" size="sm" variant="destructive" @click="emit('stop')")
          Square(class="size-4")
          span 停止
        Button(v-else size="sm" :disabled="!connected || !model || busy" @click="submit")
          Send(class="size-4")
          span 发送
</template>
