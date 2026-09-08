<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { ImagePlus, Send, Square, X } from '@lucide/vue'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from '@/client/ui/attachment'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/client/ui/input-group'
import { Spinner } from '@/client/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
import { uploadImage } from '@/client/lib/image-prep'
import { mergeRestoredText } from '@/client/stores/sync'
import type { Part } from '@/shared/parts'

interface Attached { attachment_id: number; preview: string; state: 'uploading' | 'error' | 'done' }

const props = defineProps<{
  streaming: boolean
  connected: boolean
  /** The parent owns model resolution; the Composer only knows whether a send is possible. */
  canSend: boolean
  /** Why sending is blocked, e.g. an inherited model that is no longer available (spec §9). */
  hint?: string | null
  /** Replaces the editor surface while a tool needs focused user interaction. */
  replaced?: boolean
}>()
const emit = defineEmits<{ send: [parts: Part[]]; stop: [] }>()

const text = ref('')
const images = ref<Attached[]>([])
// A counter, not a flag: concurrent uploads must not let the first one to finish clear `busy`.
const pending = ref(0)
const busy = computed(() => pending.value > 0)
const hasContent = computed(() => text.value.trim() !== '' || images.value.some((image) => image.state === 'done'))
const sendBlockedReason = computed(() => {
  if (busy.value) return '图片上传完成后即可发送'
  if (!props.connected) return '未连接'
  if (!props.canSend) return props.hint ?? '当前无法发送'
  if (!hasContent.value) return '输入消息或添加图片'
  return null
})
const fileInput = ref<HTMLInputElement | null>(null)
const box = ref<{ $el?: HTMLTextAreaElement } | HTMLTextAreaElement | null>(null)
/**
 * What the last `send` carried. The input clears optimistically so the user can keep typing, but a
 * rejected command must not swallow the message (spec §9), so it is kept here until the parent
 * either sees the message land or sees an error.
 */
const sent = ref<{ text: string; images: Attached[] } | null>(null)

/** `InputGroupTextarea` is a component, so the ref holds an instance; unwrap it to the element. */
function element(): HTMLTextAreaElement | null {
  const r = box.value
  if (!r) return null
  return r instanceof HTMLTextAreaElement ? r : (r.$el ?? null)
}
/**
 * Reset before measuring: `scrollHeight` never shrinks on its own. The cap lives in the template's
 * `max-h-[40vh]`, so past it the element scrolls and this stops changing height.
 */
function autoGrow() {
  const el = element()
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/** Takes a materialised array: a live `FileList` empties out across the `await`s below. */
async function addFiles(files: File[]) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    // Pushed before the await so the chip appears immediately and can show its own spinner.
    const item = reactive<Attached>({ attachment_id: -1, preview: URL.createObjectURL(f), state: 'uploading' })
    images.value.push(item)
    pending.value++
    try {
      const done = await uploadImage(f)
      item.attachment_id = done.attachment_id
      // `uploadImage` returns its own object URL; drop ours rather than leaking it.
      URL.revokeObjectURL(item.preview)
      item.preview = done.preview
      item.state = 'done'
    }
    catch (err) { console.error(err); item.state = 'error' }
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
async function submit() {
  if (busy.value) return
  const parts: Part[] = images.value.filter((i) => i.state === 'done').map((i) => ({ type: 'image', attachment_id: i.attachment_id }))
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (!parts.length || !props.canSend || !props.connected) return
  emit('send', parts)
  dropSent()
  sent.value = { text: text.value, images: images.value }
  text.value = ''
  images.value = []
  await nextTick()
  autoGrow()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit() }
}
function pickFiles() {
  if (busy.value) return
  fileInput.value?.click()
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
async function restoreSend() {
  const previous = sent.value
  sent.value = null
  if (!previous) return
  text.value = mergeRestoredText(previous.text, text.value)
  images.value = [...previous.images, ...images.value]
  await nextTick()
  autoGrow()
}
defineExpose({ confirmSend, restoreSend })

onBeforeUnmount(() => { releasePreviews(images.value); dropSent() })
</script>

<template lang="pug">
.p-3(@drop="onDrop" @dragover.prevent)
  .mx-auto.w-full.max-w-3xl(v-if="replaced")
    slot(name="replacement")
  InputGroup.mx-auto(v-else class="max-w-3xl rounded-xl")
    //- `w-full`: InputGroup is `items-center`, so without it the row of previews sits centred.
    AttachmentGroup.w-full.px-2(v-if="images.length")
      //- No `size`: the vendored CSS emits `group-data-[size=xs]:w-7` after
      //- `group-data-[orientation=vertical]:w-full`, so `xs` shrinks the thumbnail to 28px and
      //- leaves the rest of the chip empty. The default size is the one the docs pair with
      //- `orientation="vertical"`.
      Attachment(
        v-for="(img, i) in images" :key="i"
        orientation="vertical" :state="img.state")
        AttachmentMedia(variant="image")
          Spinner(v-if="img.state === 'uploading'")
          img(v-else-if="img.state === 'done'" :src="img.preview" alt="")
          X(v-else)
        //- `AttachmentActions` is what lifts the button onto the thumbnail; without it the X
        //- lands in flow under the image and stretches the chip.
        AttachmentActions
          AttachmentAction(class="size-10 md:size-6" title="移除" aria-label="移除图片" @click="removeImage(i)")
            X(data-icon="inline-start")
    InputGroupTextarea(
      ref="box" v-model="text" rows="2" placeholder="输入消息…"
      class="max-h-[40vh] text-base md:text-sm"
      @keydown="onKeydown" @paste="onPaste" @input="autoGrow")
    //- `align="block-end"` is what makes InputGroup lay out as a column with this row last.
    InputGroupAddon(align="block-end")
      input.hidden(ref="fileInput" type="file" accept="image/*" multiple @change="onFileChange")
      .flex.items-center.gap-1
        Tooltip
          TooltipTrigger(as-child)
            InputGroupButton(
              size="icon-xs" class="size-10 md:size-6" aria-label="添加图片"
              :disabled="busy" @click="pickFiles")
              ImagePlus(data-icon="inline-start")
          TooltipContent 添加图片
        //- Reserved for future left-side tools without moving the reasoning control out of the
        //- right action cluster.
        slot(name="left-controls")
      .ml-auto.flex.items-center.gap-1
        slot(name="controls")
        Tooltip(v-if="streaming")
          TooltipTrigger(as-child)
            InputGroupButton(
              size="icon-sm" variant="destructive" class="size-10 rounded-full md:size-8"
              aria-label="停止生成" @click="emit('stop')")
              Square(data-icon="inline-start")
          TooltipContent 停止生成
        Tooltip(v-else)
          TooltipTrigger(as-child)
            //- The tooltip must remain reachable while blocked, so this one control uses
            //- `aria-disabled`; `submit` keeps the same hard guard as the keyboard path.
            InputGroupButton(
              size="icon-sm" variant="default"
              class="size-10 rounded-full aria-disabled:opacity-50 md:size-8"
              aria-label="发送消息" :aria-disabled="sendBlockedReason !== null" @click="submit")
              Send(data-icon="inline-start")
          TooltipContent {{ sendBlockedReason ?? '发送消息' }}
</template>
