<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useDropZone } from '@vueuse/core'
import { ArrowUp, Clock3, FileIcon, ImagePlus, Send, Square, X, Zap } from '@lucide/vue'
import FileDropOverlay from '@/client/components/file-drop-overlay.vue'
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from '@/client/ui/attachment'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/client/ui/input-group'
import { Spinner } from '@/client/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
import { toast } from 'vue-sonner'
import { uploadFile, uploadMime } from '@/client/lib/file-upload'
import { useSiteConfigStore } from '@/client/stores/site-config'
import { uploadLimitLabel } from '@/shared/upload-policy'
import { uploadAccept } from '@/shared/file-media'
import AttachmentLightbox from '@/client/components/attachment-lightbox.vue'
import { mergeRestoredText } from '@/client/stores/sync'
import { api } from '@/client/lib/api'
import type { Part } from '@/shared/parts'
import { parseSlashCommand, slashCommandMenu, type SlashCommandBinding, type SlashCommandEntry, type SlashCommandInvocation } from '@/client/lib/slash-commands'

/**
 * One chip in the box. Only a file knows its MIME: an `image` part carries none, so a restored image
 * gets none rather than an invented one.
 */
type Attached = { filename?: string; attachment_id: number; preview: string; state: 'uploading' | 'error' | 'done' }
  & ({ kind: 'image' } | { kind: 'file'; mime: string; sourceEncoding?: string })

function toPart(item: Attached): Part {
  return item.kind === 'image'
    ? { type: 'image', attachment_id: item.attachment_id, ...(item.filename ? { filename: item.filename } : {}) }
    : {
        type: 'file', attachment_id: item.attachment_id, mime: item.mime, filename: item.filename,
        ...(item.sourceEncoding ? { source_encoding: item.sourceEncoding } : {}),
      }
}

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
  /** Commands the box offers and runs; without it every `/…` is ordinary text. */
  slash?: SlashCommandBinding
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

const siteConfig = useSiteConfigStore()
onMounted(() => { void siteConfig.load().catch(() => {}) })
const uploadPolicy = computed(() => siteConfig.config?.uploads)
const fileAccept = computed(() => uploadAccept(uploadPolicy.value?.allowedMimeTypes ?? []))
const uploadsOff = computed(() => uploadPolicy.value?.allowedMimeTypes.length === 0)
const uploadHint = computed(() => {
  if (!uploadPolicy.value) return '添加文件'
  return uploadsOff.value ? '本站已关闭文件上传' : `添加文件（最大 ${uploadLimitLabel(uploadPolicy.value.maxBytes)}）`
})
const dropLabel = computed(() => (uploadsOff.value ? uploadHint.value : `松开以${uploadHint.value}`))
const text = ref('')
const attachments = ref<Attached[]>([])
/** Uploaded images waiting to be sent, stepped through together in the lightbox. */
const trayImages = computed(() => attachments.value.filter(item => item.kind === 'image' && item.state === 'done'))
const lightboxImages = computed(() => trayImages.value.map(item => ({ url: item.preview, name: item.filename })))
const lightboxIndex = ref<number | null>(null)
function openTrayImage(item: Attached) {
  lightboxIndex.value = trayImages.value.indexOf(item)
}
// A counter, not a flag: concurrent uploads must not let the first one to finish clear `busy`.
const pending = ref(0)
const busy = computed(() => pending.value > 0)
/** What is typed, when it is a command rather than a message (spec §4.3). */
const typedCommand = computed(() => (props.slash ? parseSlashCommand(text.value, props.slash.commands) : null))
const commandRunning = ref(false)
/** Dismissed by Escape until the text changes again. */
const menuDismissed = ref(false)
const menuIndex = ref(0)
const menu = computed(() => (menuDismissed.value || !props.slash ? [] : slashCommandMenu(text.value, props.slash.commands)))
watch(text, () => { menuDismissed.value = false; menuIndex.value = 0 })
const hasContent = computed(() => text.value.trim() !== '' || attachments.value.some((item) => item.state === 'done'))
/**
 * Set the moment stopping or interrupting is asked for, cleared when the turn actually ends.
 *
 * Neither is instant, and a control that still looks ready is one that gets pressed again. The
 * turn ending is the honest signal that it is over, so the spinner is tied to that rather than to
 * a guess at how long an abort takes.
 */
const acting = ref(false)
watch(() => props.streaming, (still) => { if (!still) acting.value = false })

const stashed = computed(() => props.stash ?? [])
/** One line, however much is waiting: the bar is a reminder, not a second transcript. */
const stashPreview = computed(() => {
  const said = stashed.value
    .map(part => (part.type === 'text' ? part.text : part.type === 'image' ? '[图片]' : part.type === 'file' ? '[文件]' : ''))
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
  if (typedCommand.value && action.value !== 'stop' && action.value !== 'interrupt') return `执行指令 /${typedCommand.value.name}`
  if (action.value === 'send') return sendBlockedReason.value ?? '发送消息'
  if (action.value === 'stop') return '停止生成（Esc）'
  if (action.value === 'queue') {
    return stashed.value.length > 0 ? '继续排队，与已排队的消息一并送出' : '排队此消息，模型能听时再说'
  }
  return '打断当前生成，立即把已排队的消息从最近的合法位置插入对话'
})

const sendBlockedReason = computed(() => {
  // A command is never sent, so nothing that gates sending gates it.
  if (typedCommand.value) return null
  if (busy.value) return '文件上传完成后即可发送'
  if (!props.connected) return '未连接'
  if (!props.canSend) return props.hint ?? '当前无法发送'
  if (!hasContent.value) return '输入消息或添加文件'
  return null
})
const fileInput = ref<HTMLInputElement | null>(null)
const box = ref<{ $el?: HTMLTextAreaElement } | HTMLTextAreaElement | null>(null)
/**
 * What the last `send` carried. The input clears optimistically so the user can keep typing, but a
 * rejected command must not swallow the message (spec §9), so it is kept here until the parent
 * either sees the message land or sees an error.
 */
const sent = ref<{ text: string; attachments: Attached[] } | null>(null)

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
/** `pasted`: a clipboard image has only a name the browser made up, so it is sent without one. */
async function addFiles(files: File[], pasted = false) {
  pending.value++
  try {
    const policy = (await siteConfig.load()).uploads
    for (const f of files) {
      const mime = uploadMime(f)
      if (!mime) { toast.error(`不支持的文件：${f.name}`); continue }
      // Pushed before the await so the chip appears immediately and can show its own spinner.
      const item = reactive<Attached>(mime.startsWith('image/')
        ? { kind: 'image', ...(pasted ? {} : { filename: f.name }), attachment_id: -1, preview: URL.createObjectURL(f), state: 'uploading' }
        : { kind: 'file', mime, filename: f.name, attachment_id: -1, preview: URL.createObjectURL(f), state: 'uploading' })
      attachments.value.push(item)
      try {
        const done = await uploadFile(f, policy)
        item.attachment_id = done.attachment_id
        if (item.kind === 'file' && 'sourceEncoding' in done && done.sourceEncoding) item.sourceEncoding = done.sourceEncoding
        // `uploadFile` returns its own object URL; drop ours rather than leaking it.
        URL.revokeObjectURL(item.preview)
        item.preview = done.preview
        item.state = 'done'
      } catch (err) { toast.error(err instanceof Error ? err.message : String(err)); item.state = 'error' }
    }
  } catch { toast.error('无法加载上传设置，请重试') }
  finally { pending.value-- }
}

function releasePreviews(items: Attached[]) {
  for (const i of items) if (i.preview) URL.revokeObjectURL(i.preview)
}
function removeAttachment(index: number) {
  releasePreviews(attachments.value.splice(index, 1))
}
function onPaste(e: ClipboardEvent) {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.length) { e.preventDefault(); void addFiles(files, true) }
}
/** Page-wide dropping shares the same allow-list as the file picker. */
const { isOverDropZone } = useDropZone(document, {
  onDrop: files => { void addFiles(files ?? []) },
})
function dropSent() {
  if (sent.value) releasePreviews(sent.value.attachments)
  sent.value = null
}
async function submit() {
  if (busy.value) return
  const parts: Part[] = attachments.value.filter((i) => i.state === 'done').map(toPart)
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (!parts.length || !props.canSend || !props.connected) return
  emit('send', parts)
  dropSent()
  sent.value = { text: text.value, attachments: attachments.value }
  text.value = ''
  attachments.value = []
  await nextTick()
  autoGrow()
}
/** Everything in the box, as parts, leaving it empty. Shared by queueing and interrupting. */
function takeBox(): Part[] {
  const parts: Part[] = attachments.value.filter(i => i.state === 'done').map(toPart)
  if (text.value.trim()) parts.push({ type: 'text', text: text.value })
  if (parts.length === 0) return []
  dropSent()
  sent.value = { text: text.value, attachments: attachments.value }
  text.value = ''
  attachments.value = []
  return parts
}

/** Fills in the command word; running it is a separate, deliberate Enter. */
async function completeCommand(command: SlashCommandEntry) {
  text.value = `/${command.name} `
  await nextTick()
  autoGrow()
  element()?.focus()
}

/**
 * Commands never become messages and never queue. The text clears at once, as a sent message does —
 * a command can take minutes (`/compress` waits for a summary) — and comes back if the command fails,
 * unless something else has been typed meanwhile. Attachment chips are left exactly as they were.
 */
async function runCommand(invocation: SlashCommandInvocation) {
  if (!props.slash || commandRunning.value) return
  commandRunning.value = true
  const typed = text.value
  text.value = ''
  await nextTick()
  autoGrow()
  try {
    await props.slash.run(invocation)
  } catch (error) {
    if (text.value === '') text.value = typed
    await nextTick()
    autoGrow()
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    commandRunning.value = false
  }
}

function act() {
  if (acting.value) return
  // Parsed before the send/queue decision and before any send gating (spec §4.3).
  const command = typedCommand.value
  if (command) { void runCommand(command); return }
  // Read once. `action` is derived from what is in the box, and `takeBox` empties it — read again
  // afterwards it reports the state of a composer that has already been cleared, which turned
  // every queue into an interrupt: the turn was aborted by the act of typing into it.
  const doing = action.value
  if (doing === 'send') { void submit(); return }
  if (doing === 'stop') { acting.value = true; emit('stop'); return }
  // Whatever is still typed goes with it either way; leaving it behind would lose the sentence the
  // operator was in the middle of when they decided to act.
  const box = takeBox()
  if (doing === 'queue') {
    if (box.length > 0) emit('queue', box)
    return
  }
  acting.value = true
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
    if (part.type !== 'image' && part.type !== 'file') continue
    const preview = api.attachmentUrl(part.attachment_id)
    attachments.value.push(part.type === 'image'
      ? { kind: 'image', filename: part.filename, attachment_id: part.attachment_id, preview, state: 'done' }
      : { kind: 'file', mime: part.mime, filename: part.filename, sourceEncoding: part.source_encoding, attachment_id: part.attachment_id, preview, state: 'done' })
  }
  void nextTick().then(autoGrow)
}

function onMenuKeydown(e: KeyboardEvent): boolean {
  const items = menu.value
  if (items.length === 0 || e.isComposing) return false
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const step = e.key === 'ArrowDown' ? 1 : items.length - 1
    menuIndex.value = (menuIndex.value + step) % items.length
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
    void completeCommand(items[Math.min(menuIndex.value, items.length - 1)]!)
  } else if (e.key === 'Escape') {
    menuDismissed.value = true
  } else {
    return false
  }
  e.preventDefault()
  return true
}

function onKeydown(e: KeyboardEvent) {
  if (onMenuKeydown(e)) return
  // Escape undoes the last thing that was committed to, innermost first. Something waiting to be
  // said is nearer than the turn itself, so it comes back before anything is stopped — and it comes
  // back rather than going out, because sending it now is the orange button's job and not a thing
  // to reach by pressing Escape. Bound to the box, so it only answers to someone looking at it.
  if (acting.value) return
  if (e.key === 'Escape' && !e.isComposing) {
    if (stashed.value.length > 0) { e.preventDefault(); emit('withdraw'); return }
    if (props.streaming) { e.preventDefault(); acting.value = true; emit('stop') }
    return
  }
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  // Enter is the gesture for sending, so with nothing to send it does nothing. Stopping and
  // interrupting both act on an empty box, and neither is something to hand a stray keypress.
  if (!hasContent.value) return
  act()
}
/**
 * Opens the picker synchronously from the click: Safari drops the user gesture across an `await`
 * and then silently refuses to open it, so never load anything first. The cached site config
 * decides; when it has not loaded yet the picker opens anyway, and the server re-validates every
 * upload.
 */
function pickFiles() {
  if (busy.value) return
  if (uploadsOff.value) { toast.error('本站已关闭文件上传'); return }
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
 * (spec §9); an untouched Composer therefore gets it back verbatim. Its attachments are already stored
 * server-side, so re-attaching their ids costs nothing.
 */
async function restoreSend() {
  const previous = sent.value
  sent.value = null
  if (!previous) return
  text.value = mergeRestoredText(previous.text, text.value)
  attachments.value = [...previous.attachments, ...attachments.value]
  await nextTick()
  autoGrow()
}
defineExpose({ confirmSend, restoreSend, restore })

onBeforeUnmount(() => { releasePreviews(attachments.value); dropSent() })
</script>

<template lang="pug">
.p-3
  FileDropOverlay(:show="isOverDropZone" :label="dropLabel")
  //- Sits on the box the way the fold tab sits on its card: same surface, bottom corners square,
  //- so the two read as one control rather than a notice floating above one.
  .mx-auto.flex.justify-center(v-if="stashed.length" class="max-w-3xl px-2")
    button.flex.w-full.items-center.gap-2.rounded-t-xl.border-b-0.px-3.py-2.text-left.text-xs(
      type="button" class="bg-muted text-muted-foreground hover:bg-accent"
      :title="stashPreview" aria-label="撤回排队中的消息" @click="emit('withdraw')")
      Clock3(class="size-3.5 shrink-0")
      span.min-w-0.flex-1.truncate {{ stashPreview }}
      span.shrink-0.opacity-70 点击撤回（Esc）
  .mx-auto.w-full.max-w-3xl(v-if="replaced")
    slot(name="replacement")
  InputGroup.mx-auto(v-else class="max-w-3xl rounded-xl")
    //- Absolute against InputGroup (which is `relative`), so opening it never moves the box.
    //- `mousedown.prevent` keeps focus in the textarea while an option is clicked.
    .absolute.inset-x-0.z-20.mb-2.flex.flex-col.rounded-lg.border.bg-popover.p-1.text-popover-foreground.shadow-md(
      v-if="menu.length" role="listbox" aria-label="指令" class="bottom-full")
      button.flex.w-full.items-baseline.gap-2.rounded-md.px-2.text-left.text-sm(
        v-for="(command, i) in menu" :key="command.name" type="button" role="option"
        :aria-selected="i === menuIndex" :class="i === menuIndex ? 'bg-accent text-accent-foreground' : ''"
        class="min-h-10 py-1.5 md:min-h-0"
        @mousedown.prevent @click="completeCommand(command)")
        span.shrink-0.font-mono.font-medium /{{ command.name }}
        span.shrink-0.text-muted-foreground(v-if="command.argsHint") {{ command.argsHint }}
        span.ml-auto.min-w-0.truncate.text-xs.text-muted-foreground {{ command.description }}
    //- `w-full`: InputGroup is `items-center`, so without it the row of previews sits centred.
    AttachmentGroup.w-full.px-2(v-if="attachments.length")
      //- No `size`: the vendored CSS emits `group-data-[size=xs]:w-7` after
      //- `group-data-[orientation=vertical]:w-full`, so `xs` shrinks the thumbnail to 28px and
      //- leaves the rest of the chip empty. The default size is the one the docs pair with
      //- `orientation="vertical"`.
      Attachment(
        v-for="(item, i) in attachments" :key="i"
        orientation="vertical" :state="item.state")
        AttachmentMedia(variant="image")
          Spinner(v-if="item.state === 'uploading'")
          //- The media slot sizes only a direct child image, so the button carries the sizing itself.
          button.size-full.cursor-zoom-in(
            v-else-if="item.state === 'done' && item.kind === 'image'" type="button"
            :aria-label="`查看图片 ${item.filename ?? ''}`" @click="openTrayImage(item)")
            img.aspect-square.w-full.object-cover(:src="item.preview" alt="")
          FileIcon(v-else-if="item.state === 'done'" :title="item.filename")
          X(v-else)
        span.w-full.min-w-0.truncate.text-xs(v-if="item.kind === 'file'" :title="item.filename") {{ item.filename || item.mime }}
        //- The file is stored as UTF-8, so what the person downloads later is not byte for byte
        //- what they picked; they are told before sending rather than finding out then.
        span.w-full.min-w-0.truncate.text-xs.text-amber-600(
          v-if="item.kind === 'file' && item.sourceEncoding" class="dark:text-amber-400"
          :title="`编码将从 ${item.sourceEncoding} 转换为 UTF-8`") {{ item.sourceEncoding }} → UTF-8
        //- `AttachmentActions` is what lifts the button onto the thumbnail; without it the X
        //- lands in flow under the image and stretches the chip.
        AttachmentActions
          AttachmentAction(class="size-10 md:size-6" title="移除" aria-label="移除文件" @click="removeAttachment(i)")
            X(data-icon="inline-start")
    InputGroupTextarea(
      ref="box" v-model="text" rows="2" placeholder="输入消息…" data-tour="composer-input"
      class="max-h-[40vh] text-base md:text-sm"
      @keydown="onKeydown" @paste="onPaste" @input="autoGrow")
    //- `align="block-end"` is what makes InputGroup lay out as a column with this row last.
    InputGroupAddon(align="block-end")
      input.hidden(ref="fileInput" type="file" :accept="fileAccept" multiple @change="onFileChange")
      AttachmentLightbox(:images="lightboxImages" :index="lightboxIndex" @update:index="lightboxIndex = $event")
      .flex.items-center.gap-1
        Tooltip
          TooltipTrigger(as-child)
            InputGroupButton(
              size="icon-xs" class="size-10 md:size-6" aria-label="添加文件"
              :disabled="busy" @click="pickFiles")
              ImagePlus(data-icon="inline-start")
          TooltipContent {{ uploadHint }}
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
              :aria-label="actionLabel" data-tour="composer-action"
              :aria-disabled="acting || (action === 'send' && sendBlockedReason !== null)" @click="act")
              Spinner(v-if="acting || commandRunning" class="size-4")
              Square(v-else-if="action === 'stop'" data-icon="inline-start")
              ArrowUp(v-else-if="action === 'queue'" data-icon="inline-start")
              Zap(v-else-if="action === 'interrupt'" data-icon="inline-start")
              Send(v-else data-icon="inline-start")
          TooltipContent {{ actionHint }}
</template>
