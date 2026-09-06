<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { RotateCcw } from '@lucide/vue'
import MessageList from '@/client/components/message-list.vue'
import Composer from '@/client/components/composer.vue'
import ModelPicker from '@/client/components/model-picker.vue'
import ReasoningControl from '@/client/components/reasoning-control.vue'
import SessionSettings from '@/client/components/session-settings.vue'
import { routeParamToId } from '@/client/lib/route-params'
import {
  choiceFromParams, DISCONNECTED_MESSAGE, effectiveModelFor, modelOverrideAfterPick, nextSendState,
  paramsFromFields, sendCommandFor, sessionFormFrom, sessionSettingSources, useSyncStore,
  type OutstandingSend, type ReasoningChoice, type SendEvent, type SessionConfigSource,
  type SessionSettingsForm,
} from '@/client/stores/sync'
import { useConfigStore } from '@/client/stores/config'
import type { ModelRef } from '@/shared/api'
import type { Part } from '@/shared/parts'

const props = defineProps<{ sessionId: number | null }>()
const route = useRoute()
const router = useRouter()
const sync = useSyncStore()
const config = useConfigStore()

const sid = computed(() => props.sessionId)
const session = computed(() => (sid.value === null ? undefined : sync.sessions.get(sid.value)))
const path = computed(() => (sid.value === null ? [] : sync.pathFor(sid.value)))
const streaming = computed(() => sid.value !== null && sync.isStreaming(sid.value))
const composer = ref<InstanceType<typeof Composer> | null>(null)

// ---- draft and session settings

/**
 * A new chat started from a Project row carries it in the query; no session is created yet
 * (spec §5.2). A Project deleted between opening the page and sending is dropped rather than sent:
 * the foreign key would reject the whole message over a container that no longer exists. Before the
 * Projects list has loaded nothing is known to be missing, so the id is kept.
 */
const draftProjectId = computed(() => {
  const raw = route.query.project
  const id = routeParamToId(typeof raw === 'string' ? raw : undefined)
  if (id === null) return null
  return !sync.projectsLoaded || sync.projects.has(id) ? id : null
})
/** The draft's session-level model override, mirroring `sessions.provider_id` before it exists. */
const draftModel = ref<ModelRef | null>(null)
const form = reactive<SessionSettingsForm>(sessionFormFrom(undefined))
const formLoaded = ref(false)

const project = computed(() => {
  const id = sid.value === null ? draftProjectId.value : session.value?.project_id ?? null
  return id === null ? undefined : sync.projects.get(id)
})
/** The session's own model override; for a draft it is the one held locally. */
const override = computed<ModelRef | null>(() => {
  if (sid.value === null) return draftModel.value
  const s = session.value
  return s && s.provider_id !== null && s.model_id !== null ? { provider_id: s.provider_id, model_id: s.model_id } : null
})

// The form holds only what this session overrides, so it is filled once per session: a concurrent
// update from another device must not overwrite what is being typed. A draft starts blank.
watch(sid, (id) => {
  formLoaded.value = id === null
  if (id === null) Object.assign(form, sessionFormFrom(undefined))
}, { immediate: true })
watchEffect(() => {
  const s = session.value
  if (s && !formLoaded.value) { Object.assign(form, sessionFormFrom(s)); formLoaded.value = true }
})

/** What the badges read: the live form plus the model override, for a draft and a session alike. */
const configSource = computed<SessionConfigSource>(() => ({
  system_prompt: form.system_prompt.trim() === '' ? null : form.system_prompt,
  provider_id: override.value?.provider_id ?? null,
  model_id: override.value?.model_id ?? null,
  params: paramsFromFields(form),
}))
const sources = computed(() => sessionSettingSources(configSource.value, project.value))

// ---- model and reasoning

/** Only a deliberate pick is remembered globally; it is the lowest layer of the precedence. */
const picked = ref<ModelRef | null>(readModel())
const effective = computed(() => effectiveModelFor(override.value, project.value, picked.value))
const entry = computed(() => config.modelFor(effective.value.model))
// While the config is still loading nothing is known to be unavailable, so sending stays possible.
const modelAvailable = computed(() => !config.loaded || config.isAvailable(effective.value.model))
const canSend = computed(() => effective.value.model !== null && modelAvailable.value)
const sendHint = computed(() => {
  if (effective.value.model === null) return '未选择模型'
  if (modelAvailable.value) return null
  const source = effective.value.source
  return `模型不可用（来源：${source === 'session' ? '会话' : source === 'project' ? 'Project' : '当前选择'}）`
})

/**
 * The reasoning control derives its own stops; it only needs the resolved model's declarations.
 * Both are `null` until the config loads, which is also what `noModel` below reports.
 */
const capabilities = computed(() => entry.value?.model.capabilities ?? null)
const protocol = computed(() => entry.value?.provider.protocol ?? null)
/** What the session inherits when it sets nothing itself. */
const inheritedReasoning = computed<ReasoningChoice>(() => choiceFromParams(project.value?.params))
/** The three widgets always show the effective value, never the raw override (spec §5.6). */
const activeReasoning = computed<ReasoningChoice>(() => (
  form.reasoning === 'inherit' ? inheritedReasoning.value : form.reasoning
))

// A remembered model whose provider/model was since deleted or disabled would leave 发送 enabled
// against a model the server will reject; drop it once the config is known.
watch(() => [config.loaded, config.enabledModels().map((e) => `${e.provider.id}:${e.model.model_id}`).join('|')] as const, () => {
  if (config.loaded && picked.value && !config.isAvailable(picked.value)) picked.value = null
}, { immediate: true })

watch(sid, (id) => { if (id !== null) void sync.loadMessages(id) }, { immediate: true })
// Reload on the snapshot itself, not on `status` flipping to `open`: `status` changes before the
// snapshot event is applied, so a reload keyed on it can race ahead and miss messages that only
// the snapshot's reconciliation reveals as finished. `snapshotSeq` starts at 0, so skip that
// initial value — only a later increment means a snapshot actually landed.
watch(() => sync.snapshotSeq, (seq) => { if (seq > 0 && sid.value !== null) void sync.loadMessages(sid.value) })

// ---- outstanding send

/**
 * Whether a `send` is still unaccounted for. `nextSendState` owns the rule; this only runs the
 * effect and the give-up timer. Errors carry no `request_id` back to the client, so `lastError` is
 * cleared before every command and any error that follows is treated as this one's: the worst case
 * is restoring a message that did arrive, which is still better than swallowing one (spec §9).
 */
const outstanding = ref<OutstandingSend>('idle')
let outstandingTimer: ReturnType<typeof setTimeout> | undefined

function dispatch(event: SendEvent) {
  const step = nextSendState(outstanding.value, event)
  outstanding.value = step.state
  clearTimeout(outstandingTimer)
  outstandingTimer = step.state === 'outstanding' ? setTimeout(() => dispatch('timeout'), 10_000) : undefined
  if (step.effect === 'confirm') composer.value?.confirmSend()
  else if (step.effect === 'restore') composer.value?.restoreSend()
}

// The route record is shared by every /c/:id, so this component instance is reused across a chat
// switch and has to drop everything belonging to the previous chat: an outstanding send resolved
// against the next chat would restore the previous chat's message into its Composer. Not
// `immediate` — nothing is outstanding before the first send, and `outstanding` is declared here.
watch(sid, () => dispatch('abandoned'))

// A `send` on a fresh page creates the session server-side; jump to it when it appears. The route
// change swaps in a different page component, so this Composer unmounts with nothing left to keep.
watch(() => sync.sessionList[0]?.id, (newest) => {
  if (outstanding.value === 'outstanding' && newest !== undefined && sid.value === null) {
    dispatch('abandoned')
    void router.push(`/c/${newest}`)
  }
})
watch(() => path.value.length, () => dispatch('landed'))
watch(() => sync.lastError, (e) => { if (e !== null) dispatch('error') })
onBeforeUnmount(() => clearTimeout(outstandingTimer))

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
  dispatch('send')
  send(sendCommandFor({
    sessionId: sid.value,
    parentId: session.value?.head_message_id ?? null,
    parts,
    model,
    draft: {
      project_id: draftProjectId.value,
      system_prompt: form.system_prompt,
      model: draftModel.value,
      params: paramsFromFields(form),
    },
  }))
}
/**
 * Deliberately not routed through `send`: unlike a settings write, `stop` is idempotent and carries
 * no stale state, so one queued by `WsClient` and delivered on reconnect still does exactly what was
 * asked — the generation runs in the DO, not in the socket, and keeps costing tokens meanwhile. The
 * 停止 button is also not gated on the connection the way 发送 is, so refusing here would turn a
 * command that would have worked into a dead click.
 */
function onStop() {
  if (sid.value !== null) sync.send({ type: 'stop', session_id: sid.value })
}

/** The whole form is the session's own overrides, so a restored field simply stops being sent. */
function commitSettings() {
  if (sid.value === null) return
  const title = form.title.trim()
  send({
    type: 'session.update',
    session_id: sid.value,
    ...(title ? { title } : {}),
    system_prompt: form.system_prompt.trim() === '' ? null : form.system_prompt,
    params: paramsFromFields(form),
  })
}

function setOverride(value: ModelRef | null) {
  if (sid.value === null) { draftModel.value = value; return }
  send({
    type: 'session.update',
    session_id: sid.value,
    provider_id: value?.provider_id ?? null,
    model_id: value?.model_id ?? null,
  })
}

/**
 * A pick has to reach the session itself whenever a Project default or an existing override would
 * outrank the model `send` carries (spec §5.3); otherwise the pick is only the remembered choice.
 */
function onModelChange(value: ModelRef | null) {
  picked.value = value
  localStorage.setItem('oc.model', JSON.stringify(value))
  const next = modelOverrideAfterPick(value, project.value, override.value)
  if (next !== undefined) setOverride(next)
}

function onReasoningChange(choice: ReasoningChoice) {
  form.reasoning = choice
  commitSettings()
}
</script>

<template lang="pug">
.flex.h-full.flex-col
  Teleport(to="#page-header")
    span.shrink-0.truncate.text-sm.text-muted-foreground(v-if="project") {{ project.name }}
    span.shrink-0.text-muted-foreground(v-if="project") ›
    ModelPicker(:model-value="effective.model" @update:model-value="onModelChange")
    button.shrink-0.text-muted-foreground(
      v-if="sources.model === 'session'" type="button" title="恢复继承"
      class="hover:text-foreground" @click="setOverride(null)")
      RotateCcw(class="size-3.5")
    .ml-auto.shrink-0
      SessionSettings(
        :form="form" :sources="sources" :project="project" :has-session="sid !== null"
        @commit="commitSettings")
  .min-h-0.flex-1
    MessageList(v-if="path.length" :messages="path")
    .flex.h-full.items-center.justify-center.text-muted-foreground(v-else) 开始一段新对话
  Composer(
    ref="composer" :streaming="streaming" :connected="sync.status === 'open'"
    :can-send="canSend" :hint="sendHint" @send="onSend" @stop="onStop")
    template(#controls)
      ReasoningControl(
        :capabilities="capabilities" :protocol="protocol" :active="activeReasoning"
        :overridden="form.reasoning !== 'inherit'" :no-model="entry === undefined"
        @update="onReasoningChange")
</template>
