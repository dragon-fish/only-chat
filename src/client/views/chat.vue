<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch, watchEffect } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { RouterLink, useRouter } from 'vue-router'
import { ArrowLeftIcon, RotateCcwIcon } from '@lucide/vue'
import MessageList from '@/client/components/message-list.vue'
import Composer from '@/client/components/composer.vue'
import ModelPicker from '@/client/components/model-picker.vue'
import ProjectAvatar from '@/client/components/project-avatar.vue'
import ReasoningControl from '@/client/components/reasoning-control.vue'
import ConversationSettings from '@/client/components/conversation-settings.vue'
import ConversationMapDialog from '@/client/components/conversation-map-dialog.vue'
import CollectionState from '@/client/components/collection-state.vue'
import ContextUsageIndicator from '@/client/components/context-usage-indicator.vue'
import ToolSelector from '@/client/components/tool-selector.vue'
import WorkspaceFilesDialog from '@/client/components/workspace-files-dialog.vue'
import ToolPartRenderer from '@/client/components/tool-part-renderer.vue'
import { defaultToolsForSettings, conversationToolBlockReason } from '@/client/components/tool-selector'
import { pendingAskUserCalls } from '@/client/components/tool-part-renderer'
import { pluginManifests } from '@/client/plugins/loaders'
import { projectPresentation, conversationPath } from '@/client/lib/ui-models'
import {
  choiceFromParams, DISCONNECTED_MESSAGE, effectiveModelFor, modelOverrideAfterPick, nextSendState,
  optimisticUserMessage, paramsFromFields, sendCommandFor, conversationFormFrom, conversationSettingSources, useSyncStore,
  withOptimisticUserMessage,
  type OutstandingSend, type ReasoningChoice, type SendEvent, type ConversationConfigSource,
  type ConversationSettingsForm,
} from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import { Button } from '@/client/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import type { ModelRef } from '@/shared/api'
import type { Message } from '@/shared/models'
import type { Part } from '@/shared/parts'

const props = withDefaults(defineProps<{ conversationId: number | null; projectId?: number | null }>(), { projectId: null })
const router = useRouter()
const sync = useSyncStore()
const config = useConfigStore()
const isDesktop = useMediaQuery('(min-width: 768px)')

const sid = computed(() => props.conversationId)
const conversation = computed(() => (sid.value === null ? undefined : sync.conversations.get(sid.value)))
const path = computed(() => (sid.value === null ? [] : sync.pathFor(sid.value)))
const streaming = computed(() => sid.value !== null && sync.isStreaming(sid.value))
const composer = ref<InstanceType<typeof Composer> | null>(null)
const messageList = ref<{ scrollToMessage: (messageId: number) => boolean } | null>(null)
const draftTools = ref<string[] | null>(null)
const draftToolsEnabled = ref(true)
const outstanding = ref<OutstandingSend>('idle')
const optimisticRequestId = ref<string | null>(null)
const optimisticBaseIds = ref(new Set<number>())
let nextOptimisticId = -1
const optimisticMessage = computed<Message | null>(() => {
  const requestId = optimisticRequestId.value
  if (!requestId) return null
  const mutation = sync.optimisticMutations.get(requestId)
  return mutation?.kind === 'message' ? mutation.message : null
})
const visiblePath = computed(() => withOptimisticUserMessage(path.value, optimisticMessage.value))

// ---- draft and conversation settings

/**
 * The nested Project workspace supplies the draft context; no conversation is created yet
 * (spec §5.2). A Project deleted between opening the page and sending is dropped rather than sent:
 * the foreign key would reject the whole message over a container that no longer exists. Before the
 * Projects list has loaded nothing is known to be missing, so the id is kept.
 */
const draftProjectId = computed(() => {
  const id = props.projectId
  if (id === null) return null
  return !sync.projectsLoaded || sync.projects.has(id) ? id : null
})
/** The draft's conversation-level model override, mirroring `conversations.provider_id` before it exists. */
const draftModel = ref<ModelRef | null>(null)
const form = reactive<ConversationSettingsForm>(conversationFormFrom(undefined))
const formLoaded = ref(false)

const project = computed(() => {
  const id = sid.value === null ? draftProjectId.value : conversation.value?.project_id ?? null
  return id === null ? undefined : sync.projects.get(id)
})
const projectTitle = computed(() => project.value ? projectPresentation(project.value.name).title : '')
const backTarget = computed(() => {
  const projectId = project.value?.id ?? draftProjectId.value
  return projectId === null ? '/chats' : `/project/${projectId}`
})
/** The conversation's own model override; for a draft it is the one held locally. */
const override = computed<ModelRef | null>(() => {
  if (sid.value === null) return draftModel.value
  const s = conversation.value
  return s && s.provider_id !== null && s.model_id !== null ? { provider_id: s.provider_id, model_id: s.model_id } : null
})

// The form holds only what this conversation overrides, so it is filled once per conversation: a concurrent
// update from another device must not overwrite what is being typed. A draft starts blank.
watch(sid, (id) => {
  formLoaded.value = id === null
  if (id === null) {
    Object.assign(form, conversationFormFrom(undefined))
    draftTools.value = null
    draftToolsEnabled.value = true
  }
}, { immediate: true })
watchEffect(() => {
  const s = conversation.value
  if (s && !formLoaded.value) { Object.assign(form, conversationFormFrom(s)); formLoaded.value = true }
})

/** What the badges read: the live form plus the model override, for a draft and a conversation alike. */
const configSource = computed<ConversationConfigSource>(() => ({
  system_prompt: form.system_prompt.trim() === '' ? null : form.system_prompt,
  provider_id: override.value?.provider_id ?? null,
  model_id: override.value?.model_id ?? null,
  params: paramsFromFields(form),
}))
const sources = computed(() => conversationSettingSources(configSource.value, project.value))

// ---- model and reasoning

/** Only a deliberate pick is remembered globally; it is the lowest layer of the precedence. */
const picked = ref<ModelRef | null>(readModel())
/** A deliberate choice on an existing chat outranks its history until that choice produces a message. */
const conversationPick = ref<ModelRef | null | undefined>(undefined)
watch(sid, () => { conversationPick.value = undefined }, { flush: 'sync' })
const effective = computed(() => effectiveModelFor(override.value, project.value, picked.value, sid.value === null
  ? undefined
  : {
      localPick: conversationPick.value,
      messagesLoaded: sync.loadedMessageConversations.has(sid.value),
      messages: path.value,
    }))
const entry = computed(() => config.modelFor(effective.value.model))
const contextUsage = computed(() => {
  const model = effective.value.model
  const latest = [...path.value].reverse().find(message => message.role === 'assistant')
  const limit = entry.value?.model.metadata.limit?.context
  if (!model || !latest?.usage || limit === undefined) return null
  if (latest.provider_id !== model.provider_id || latest.model_id !== model.model_id) return null
  return { usage: latest.usage, limit }
})
// While the config is still loading nothing is known to be unavailable, so sending stays possible.
const modelAvailable = computed(() => !config.loaded || config.isAvailable(effective.value.model))
const selectedTools = computed(() => sid.value === null ? (draftTools.value ?? []) : (conversation.value?.tools ?? []))
const toolsEnabled = computed(() => sid.value === null ? draftToolsEnabled.value : conversation.value?.tools_enabled !== false)
const optimisticToolCallIds = computed(() => {
  const headId = conversation.value?.head_message_id
  return headId === null || headId === undefined ? new Set<string>() : sync.optimisticToolCallIds(headId)
})
const pendingToolCall = computed(() => pendingAskUserCalls(
  path.value,
  conversation.value?.head_message_id,
  optimisticToolCallIds.value,
)[0] ?? null)
/**
 * A model without tool-call support does not block the send: the server drops the tool definitions
 * for that turn and the Conversation keeps its selection, because clearing it by hand to send one
 * message — and restoring it afterwards — is busywork.
 */
// An unresolved model proves nothing unsupported, so the selector stays lit until one is known.
const toolsSupported = computed(() => entry.value === undefined || entry.value.model.metadata.tool_call === true)
const toolBlockReason = computed(() => conversationToolBlockReason({
  draft: sid.value === null,
  settingsLoaded: sync.settingsLoaded,
  pending: pendingToolCall.value !== null,
}))
const messageHistoryReady = computed(() => sid.value === null || sync.loadedMessageConversations.has(sid.value))
const canSend = computed(() => (
  effective.value.model !== null
  && modelAvailable.value
  && toolBlockReason.value === null
  && messageHistoryReady.value
  && outstanding.value === 'idle'
))
const sendHint = computed(() => {
  if (!messageHistoryReady.value) return '正在加载对话…'
  if (outstanding.value === 'outstanding') return '消息发送中…'
  if (toolBlockReason.value) return toolBlockReason.value
  if (effective.value.model === null) return '未选择模型'
  if (modelAvailable.value) return null
  const source = effective.value.source
  return `模型不可用（来源：${source === 'conversation' ? '会话' : source === 'project' ? 'Project' : '当前选择'}）`
})

/**
 * The reasoning control derives its own stops; it only needs the resolved model's declarations.
 * Both are `null` until the config loads, which is also what `noModel` below reports.
 */
const metadata = computed(() => entry.value?.model.metadata ?? null)
watchEffect(() => {
  if (sid.value === null && sync.settingsLoaded && draftTools.value === null) {
    draftTools.value = defaultToolsForSettings(pluginManifests, sync.settings.plugins, sync.pluginConfig)
  }
})
/** What the conversation inherits when it sets nothing itself. */
const inheritedReasoning = computed<ReasoningChoice>(() => choiceFromParams(project.value?.params))
/** The three widgets always show the effective value, never the raw override (spec §5.6). */
const activeReasoning = computed<ReasoningChoice>(() => (
  form.reasoning === 'inherit' ? inheritedReasoning.value : form.reasoning
))

// An unloaded page does not prove a remembered model is unavailable. Wait for its explicit read.
watch(() => {
  const model = picked.value
  return [config.loaded, model,
    config.providerRecords.find(provider => provider.id === model?.provider_id)?.enabled,
    model ? config.modelsByRef[`${model.provider_id}:${model.model_id}`]?.enabled : undefined,
  ] as const
}, ([loaded, model, providerEnabled, modelEnabled]) => {
  if (loaded && model && (providerEnabled !== true || modelEnabled === false)) picked.value = null
}, { immediate: true })

const messageLoadError = ref<string | null>(null)
let messageLoadToken = 0
async function loadMessages() {
  const id = sid.value
  const token = ++messageLoadToken
  messageLoadError.value = null
  if (id === null) return
  try { await sync.loadMessages(id) }
  catch (error) {
    if (token === messageLoadToken) messageLoadError.value = error instanceof Error ? error.message : String(error)
  }
}
watch(sid, loadMessages, { immediate: true })
// Reload on the snapshot itself, not on `status` flipping to `open`: `status` changes before the
// snapshot event is applied, so a reload keyed on it can race ahead and miss messages that only
// the snapshot's reconciliation reveals as finished. `snapshotSeq` starts at 0, so skip that
// initial value — only a later increment means a snapshot actually landed.
watch(() => sync.snapshotSeq, (seq) => { if (seq > 0 && sid.value !== null) void loadMessages() })

function focusComposer() { composer.value?.$el.querySelector('textarea')?.focus() }

async function retryChat() {
  await Promise.allSettled([sync.loadConversations(), loadMessages()])
}

// ---- outstanding send

/**
 * Whether a `send` is still unaccounted for. `nextSendState` owns the rule; this only runs the
 * effect and the give-up timer. Errors carry no `request_id` back to the client, so `lastError` is
 * cleared before every command and any error that follows is treated as this one's: the worst case
 * is restoring a message that did arrive, which is still better than swallowing one (spec §9).
 */
let outstandingTimer: ReturnType<typeof setTimeout> | undefined

function dispatch(event: SendEvent) {
  const step = nextSendState(outstanding.value, event)
  outstanding.value = step.state
  clearTimeout(outstandingTimer)
  outstandingTimer = step.state === 'outstanding' ? setTimeout(() => dispatch('timeout'), 10_000) : undefined
  const requestId = optimisticRequestId.value
  if (step.effect !== 'none' && requestId) {
    if (event === 'landed') sync.confirmOptimistic(requestId)
    else if (event === 'error') sync.rejectOptimistic(requestId)
    else sync.abandonOptimistic(requestId)
    optimisticRequestId.value = null
    optimisticBaseIds.value = new Set()
  }
  if (step.effect === 'confirm') composer.value?.confirmSend()
  else if (step.effect === 'restore') composer.value?.restoreSend()
}

// The route record is shared by every /c/:id, so this component instance is reused across a chat
// switch and has to drop everything belonging to the previous chat: an outstanding send resolved
// against the next chat would restore the previous chat's message into its Composer. Not
// `immediate` — nothing is outstanding before the first send, and `outstanding` is declared here.
watch(sid, (id, previous) => {
  const requestId = optimisticRequestId.value
  const optimistic = requestId ? sync.optimisticMutations.get(requestId) : undefined
  if (requestId && previous === null && id !== null && optimistic?.kind === 'message' && optimistic.message.conversation_id === -1) {
    sync.beginOptimistic(requestId, { kind: 'message', message: { ...optimistic.message, conversation_id: id } })
    return
  }
  dispatch('abandoned')
})

// A `send` on a fresh page creates the conversation server-side; jump to it when it appears. `/new` and
// `/c/:id` share one aliased route record, so only this prop changes and the focused Composer stays.
watch(() => sync.conversationList[0]?.id, (newest) => {
  if (outstanding.value === 'outstanding' && newest !== undefined && sid.value === null) {
    const created = sync.conversations.get(newest)
    if (created) void router.push(conversationPath(created))
  }
})
watch(() => path.value.map(message => message.id), () => {
  if (!optimisticMessage.value) return
  const landed = path.value.some(message => (
    message.id > 0 && message.role === 'user' && !optimisticBaseIds.value.has(message.id)
  ))
  if (landed) dispatch('landed')
})
watch(() => sync.lastError, (e) => { if (e !== null) dispatch('error') })
onBeforeUnmount(() => {
  clearTimeout(outstandingTimer)
  if (optimisticRequestId.value) sync.abandonOptimistic(optimisticRequestId.value)
})

function readModel(): ModelRef | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('oc.model') ?? 'null')
    if (raw === null || typeof raw !== 'object') return null
    const candidate = raw as Partial<ModelRef>
    return typeof candidate.provider_id === 'number' && typeof candidate.model_id === 'string'
      ? { provider_id: candidate.provider_id, model_id: candidate.model_id }
      : null
  } catch { return null }
}

/**
 * Every command clears the previous error first, so the next one belongs to this command. A socket
 * that is not open is a refusal, not a delay: the Composer already hard-gates 发送 the same way, and
 * a settings command that leaves no trace here is one a slider move or a model pick was silently
 * lost to (spec §9). Returns whether the command actually left.
 */
function send(command: Parameters<typeof sync.send>[0]): boolean {
  sync.lastError = null
  if (sync.status !== 'open' || !sync.send(command)) {
    sync.lastError = DISCONNECTED_MESSAGE
    return false
  }
  return true
}

function onSend(parts: Part[]) {
  const model = effective.value.model
  if (!model) return
  const requestId = crypto.randomUUID()
  optimisticBaseIds.value = new Set(path.value.map(message => message.id))
  optimisticRequestId.value = requestId
  sync.beginOptimistic(requestId, { kind: 'message', message: optimisticUserMessage({
    id: nextOptimisticId--,
    conversationId: sid.value ?? -1,
    parentId: conversation.value?.head_message_id ?? null,
    parts,
    createdAt: Date.now(),
  }) })
  dispatch('send')
  send({ ...sendCommandFor({
    conversationId: sid.value,
    parentId: conversation.value?.head_message_id ?? null,
    parts,
    model,
    draft: {
      project_id: draftProjectId.value,
      system_prompt: form.system_prompt,
      model: draftModel.value,
      params: paramsFromFields(form),
      tools: selectedTools.value,
      tools_enabled: draftToolsEnabled.value,
    },
  }), request_id: requestId })
}
/**
 * Deliberately not routed through `send`: unlike a settings write, `stop` is idempotent and carries
 * no stale state, so one queued by `WsClient` and delivered on reconnect still does exactly what was
 * asked — the generation runs in the DO, not in the socket, and keeps costing tokens meanwhile. The
 * 停止 button is also not gated on the connection the way 发送 is, so refusing here would turn a
 * command that would have worked into a dead click.
 */
function onStop() {
  if (sid.value !== null) sync.send({ type: 'stop', conversation_id: sid.value })
}

/** The whole form is the conversation's own overrides, so a restored field simply stops being sent. */
function commitSettings() {
  if (sid.value === null) return
  const title = form.title.trim()
  send({
    type: 'conversation.update',
    conversation_id: sid.value,
    ...(title ? { title } : {}),
    system_prompt: form.system_prompt.trim() === '' ? null : form.system_prompt,
    params: paramsFromFields(form),
  })
}

function setOverride(value: ModelRef | null) {
  if (sid.value === null) { draftModel.value = value; return }
  send({
    type: 'conversation.update',
    conversation_id: sid.value,
    provider_id: value?.provider_id ?? null,
    model_id: value?.model_id ?? null,
  })
}

/**
 * A pick has to reach the conversation itself whenever a Project default or an existing override would
 * outrank the model `send` carries (spec §5.3); otherwise the pick is only the remembered choice.
 */
function onModelChange(value: ModelRef | null) {
  picked.value = value
  localStorage.setItem('oc.model', JSON.stringify(value))
  if (sid.value !== null) conversationPick.value = value
  const next = modelOverrideAfterPick(value, project.value, override.value)
  if (next !== undefined) setOverride(next)
}

function onReasoningChange(choice: ReasoningChoice) {
  form.reasoning = choice
  commitSettings()
}

/** The map hands back a message id after closing; the scroller lives inside MessageList. */
function onLocateMessage(messageId: number) {
  void nextTick(() => messageList.value?.scrollToMessage(messageId))
}

function onToolsChange(tools: string[]) {
  if (sid.value === null) {
    draftTools.value = tools
    return
  }
  send({ type: 'conversation.update', conversation_id: sid.value, tools })
}

function onToolsEnabledChange(enabled: boolean) {
  if (sid.value === null) {
    draftToolsEnabled.value = enabled
    return
  }
  send({ type: 'conversation.update', conversation_id: sid.value, tools_enabled: enabled })
}
</script>

<template lang="pug">
.flex.h-full.flex-col
  Teleport(to="#page-header" defer)
    .flex.min-w-0.flex-1.items-center.gap-1
      template(v-if="!isDesktop")
        Button(as-child variant="ghost" size="icon-sm" class="size-10")
          RouterLink(:to="backTarget" aria-label="返回聊天")
            ArrowLeftIcon
        template(v-if="project")
          ProjectAvatar(:project="project" size="sm")
          span.min-w-0.flex-1.truncate.text-sm.font-medium {{ projectTitle }}
        span.min-w-0.flex-1.truncate.text-sm.font-medium(v-else) 随心聊
      ModelPicker(:compact="!isDesktop" :model-value="effective.model" @update:model-value="onModelChange")
      Button(
        v-if="sources.model === 'conversation'" variant="ghost" size="icon-xs"
        class="min-h-10 min-w-10 md:min-h-6 md:min-w-6"
        title="恢复继承模型" aria-label="恢复继承模型" @click="setOverride(null)")
        RotateCcwIcon
      .ml-auto.flex.shrink-0.items-center.gap-1
        ConversationMapDialog(:conversation-id="sid" @locate="onLocateMessage")
        WorkspaceFilesDialog(mount="conversation" :scope-id="sid")
        ConversationSettings(
          :form="form" :sources="sources" :project="project" :has-conversation="sid !== null"
          @commit="commitSettings")
  .min-h-0.flex-1
    CollectionState(:loaded="visiblePath.length > 0 || sid === null || (sync.conversationsLoaded && sync.loadedMessageConversations.has(sid))" :error="messageLoadError || (sid !== null ? sync.conversationsError : null)" :retry="retryChat")
      MessageList(
        v-if="visiblePath.length" ref="messageList" :key="sid ?? 'draft'" :messages="visiblePath" :project="project"
        :effective-model="effective"
        :optimistic-id="optimisticMessage?.id")
      Empty(v-else class="h-full")
        EmptyHeader
          EmptyTitle 开始一段新对话
          EmptyDescription 从下方输入消息，开启这次交流。
        EmptyContent
          Button(variant="outline" class="min-h-10" @click="focusComposer") 输入消息
  Composer(
    ref="composer" :streaming="streaming" :connected="sync.status === 'open'"
    :can-send="canSend" :hint="sendHint" :replaced="pendingToolCall !== null"
    @send="onSend" @stop="onStop")
    template(#replacement)
      .oc-scroll.flex.max-h-96.flex-col.overflow-y-auto(class="md:max-h-[60vh]")
        ToolPartRenderer(
          v-if="pendingToolCall" placement="composer" :message-id="pendingToolCall.messageId"
          :call="pendingToolCall.call" :result="null" :can-continue="false")
    template(#left-controls)
      ToolSelector(
        :model-value="selectedTools" :plugins="sync.settings.plugins" :plugin-config="sync.pluginConfig" :desktop="isDesktop"
        :supported="toolsSupported" :enabled="toolsEnabled" @update:enabled="onToolsEnabledChange"
        @update:model-value="onToolsChange")
    template(#controls)
      ContextUsageIndicator(v-if="contextUsage" :usage="contextUsage.usage" :limit="contextUsage.limit")
      ReasoningControl(
        :metadata="metadata" :active="activeReasoning"
        :overridden="form.reasoning !== 'inherit'" :no-model="entry === undefined"
        @update="onReasoningChange")
</template>
