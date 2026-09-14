<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue'
import { ArrowUp, Clock3, ImagePlus, Send, Square, X, Zap } from '@lucide/vue'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from '@/client/ui/attachment'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/client/ui/input-group'
import { Spinner } from '@/client/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
import { uploadImage } from '@/client/lib/image-prep'
import { mergeRestoredText } from '@/client/stores/sync'
import { api } from '@/client/lib/api'
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
  /** What the server is holding for this conversation, said while the turn ran. */
  stash?: Part[]
}>()
const emit = defineEmits<{
  send: [parts: Part[]]
  stop: []
  /** Hold these until the model can be told, at the next boundary between steps. */
  queue: [parts: Part[]]
  /** Stop the turn and say everything held, including whatever is still in the box. */
  interrupt: [parts: Part[]]
  /** Take the stash back; the parent refills the box from the server's answer. */
  withdraw: []
}>()

const text = ref('')
const images = ref<Attached[]>([])
// A counter, not a flag: concurrent uploads must not let the first one to finish clear `busy`.
const pending = ref(0)
const busy = computed(() => pending.value > 0)
const hasContent = computed(() => text.value.trim() !== '' || images.value.some((image) => image.state === 'done'))
const stashed = computed(() => props.stash ?? [])
/** One line, however much is waiting: the bar is a reminder, not a second transcript. */
const stashPreview = computed(() => {
  const said = stashed.value
    .map(part => (part.type === 'text' ? part.text : part.type === 'image' ? '[图片]' : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return said || '已排队的消息'
})

/**
 * What the right-hand control does, which is three different things while a turn is running.
 *
 * Something in the box always means queue, however much is already waiting — the queue has no
 * limit, and a control that stopped accepting additions would be refusing the obvious next thing
 * to do. Interrupting is what an empty box plus a full stash means: nothing more to add, send it
 * now rather than waiting for a boundary that may never come.
 */
type Action = 'send' | 'stop' | 'queue' | 'interrupt'
const action = computed<Action>(() => {
  if (!props.streaming) return 'send'
  if (hasContent.value) return 'queue'
  return stashed.value.length > 0 ? 'interrupt' : 'stop'
})

/** Pug attribute values cannot span lines, so the conditional classes are assembled here. */
const actionClass = computed(() => [
  'size-10 rounded-full aria-disabled:opacity-50 md:size-8',
  action.value === 'interrupt' ? 'bg-amber-500 text-black hover:bg-amber-400' : '',
])

const actionLabel = computed(() => ({
  send: '发送消息', stop: '停止生成', queue: '排队此消息', interrupt: '打断并立即送出已排队的消息',
}[action.value]))

const actionHint = computed(() => {
  if (action.value === 'send') return sendBlockedReason.value ?? '发送消息'
  if (action.value === 'stop') return '停止生成'
  if (action.value === 'queue') {
    return stashed.value.length > 0 ? '继续排队，与已排队的消息一并送出' : '排队此消息，模型能听时再说'
  }
  return '打断当前生成，立即把已排队的消息从最近的合法位置插入对话'
})

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
/** Everything in the box, as parts, leaving it empty. Shared by queueing and interrupting. */
function takeBox(): Part[] {
  const parts: Part[] = images.value.filter(i => i.state === 'done').map(i => ({ type: 'image', attachment_id: i.attachment_id }))
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (parts.length === 0) return []
  dropSent()
  sent.value = { text: text.value, images: images.value }
  text.value = ''
  images.value = []
  return parts
}

function act() {
  // Read once. `action` is derived from what is in the box, and `takeBox` empties it — read again
  // afterwards it reports the state of a composer that has already been cleared, which turned
  // every queue into an interrupt: the turn was aborted by the act of typing into it.
  const doing = action.value
  if (doing === 'send') { void submit(); return }
  if (doing === 'stop') { emit('stop'); return }
  // Whatever is still typed goes with it either way; leaving it behind would lose the sentence the
  // operator was in the middle of when they decided to act.
  const box = takeBox()
  if (doing === 'queue') {
    if (box.length > 0) emit('queue', box)
    return
  }
  emit('interrupt', box)
}

/**
 * Put a withdrawn stash back in the box, so taking it back means getting it back.
 *
 * Appends rather than replaces: the operator may have started typing again while it was still
 * waiting, and dropping that would be a second, worse surprise.
 */
function restore(parts: Part[]) {
  const said = parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
  if (said) text.value = text.value.trim() ? `${said}\n${text.value}` : said
  for (const part of parts) {
    if (part.type !== 'image') continue
    images.value.push({ attachment_id: part.attachment_id, preview: api.attachmentUrl(part.attachment_id), state: 'done' })
  }
  void nextTick().then(autoGrow)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); act() }
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
defineExpose({ confirmSend, restoreSend, restore })

onBeforeUnmount(() => { releasePreviews(images.value); dropSent() })
</script>

<template lang="pug">
.p-3(@drop="onDrop" @dragover.prevent)
  //- Sits on the box the way the fold tab sits on its card: same surface, bottom corners square,
  //- so the two read as one control rather than a notice floating above one.
  .mx-auto.flex.justify-center(v-if="stashed.length" class="max-w-3xl px-2")
    button.flex.w-full.items-center.gap-2.rounded-t-xl.border-b-0.px-3.py-2.text-left.text-xs(
      type="button" class="bg-muted text-muted-foreground hover:bg-accent"
      :title="stashPreview" aria-label="撤回排队中的消息" @click="emit('withdraw')")
      Clock3(class="size-3.5 shrink-0")
      span.min-w-0.flex-1.truncate {{ stashPreview }}
      span.shrink-0.opacity-70 点击撤回
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
        Tooltip
          TooltipTrigger(as-child)
            //- The tooltip must remain reachable while blocked, so this one control uses
            //- `aria-disabled`; `act` keeps the same hard guard as the keyboard path.
            InputGroupButton(
              size="icon-sm" :variant="action === 'stop' ? 'destructive' : 'default'"
              :class="actionClass"
              :aria-label="actionLabel"
              :aria-disabled="action === 'send' && sendBlockedReason !== null" @click="act")
              Square(v-if="action === 'stop'" data-icon="inline-start")
              ArrowUp(v-else-if="action === 'queue'" data-icon="inline-start")
              Zap(v-else-if="action === 'interrupt'" data-icon="inline-start")
              Send(v-else data-icon="inline-start")
          TooltipContent {{ actionHint }}
</template>
