<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { RotateCcw, Settings2 } from '@lucide/vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from '@/client/ui/number-field'
import { Textarea } from '@/client/ui/textarea'
import { fieldLooksBlank, optionalNumber, type SessionSettingSources, type SessionSettingsForm, type SettingSource } from '@/client/stores/sync'
import type { Project } from '@/shared/models'

const props = defineProps<{
  /**
   * The live form the chat view owns. Both this popover and the Composer's reasoning slider edit
   * fields of one session, so the state is shared by reference and edits are written in place;
   * `commit` asks the owner to persist the whole form.
   */
  form: SessionSettingsForm
  sources: SessionSettingSources
  /** The Project this session inherits from, if any — its values are shown as placeholders only. */
  project: Project | undefined
  /** A draft has no title yet: the session does not exist until the first message is sent. */
  hasSession: boolean
}>()
const emit = defineEmits<{ commit: [] }>()
const open = ref(false)

const inherited = computed(() => props.project?.params)

const BADGES: Record<SettingSource, string> = {
  session: '会话覆盖',
  project: '继承自 Project',
  default: '默认',
}

type ParamKey = 'temperature' | 'top_p' | 'max_tokens'

/**
 * Blank means "inherit", so no stepper may turn it into a value. reka's `handleChangingValue`
 * writes `clampInputValue(min ?? 0)` whenever the input is empty and disables neither stepper
 * there, so ONE press of + on a blank 最大 tokens committed `max_tokens: 1` — this form commits on
 * `update:model-value` — truncating every later reply to a single token, with no undo beyond
 * noticing the badge had flipped to 会话覆盖.
 *
 * The two buttons carry `:disabled="blank(...)"`. This guard covers the paths that have no button
 * to disable: reka routes ArrowUp/ArrowDown, PageUp/PageDown, Home/End and the wheel through the
 * same handlers. It runs in the capture phase on the field root, which is before reka's own
 * listeners on the input, and it only calls `stopPropagation` — never `preventDefault`, because
 * the caret and the popover's scrolling are the browser's business and only reka's listener has
 * to be kept away from an empty box.
 */
const STEP_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'])

/**
 * The live text of each box while it is being edited, `null` when it is not. reka only writes typed
 * text back to the model on blur or Enter, so the model is the wrong thing to ask whether the box
 * the user is looking at is empty — see `fieldLooksBlank`.
 */
const typing = reactive<Record<ParamKey, string | null>>({ temperature: null, top_p: null, max_tokens: null })
function onType(field: ParamKey, event: Event) {
  typing[field] = (event.target as HTMLInputElement).value
}
/** Blur is where reka reconciles text and model, so the model becomes authoritative again. */
function onSettle(field: ParamKey) {
  typing[field] = null
}
/**
 * Escape closes this panel without ever firing `blur` — the responsive overlay is presence-gated, so the
 * focused input is detached rather than blurred, and Chrome fires nothing for a removed element.
 * Without this the tracker would outlive the box it describes: text typed and then escaped away
 * would still report the field as filled next time the panel opened, re-enabling the steppers over
 * an empty box.
 */
function resetTyping() {
  Object.assign(typing, { temperature: null, top_p: null, max_tokens: null })
}
function setOpen(next: boolean) {
  open.value = next
  if (!next) resetTyping()
}
/** Blank is `''` in the form and `undefined` through `optionalNumber` — never `0` (spec §7.3). */
function blank(field: ParamKey): boolean {
  return fieldLooksBlank(typing[field], props.form[field])
}
function guardStep(field: ParamKey, event: Event) {
  if (!blank(field)) return
  if (event instanceof KeyboardEvent && !STEP_KEYS.has(event.key)) return
  event.stopPropagation()
}

/** What a blank box would resolve to — said, never filled in, so blank still travels as absent. */
function inheritHint(field: ParamKey, value: number | undefined): string {
  const base = value === undefined ? '留空则使用默认值。' : `留空则继承 ${value}。`
  // The steppers are disabled while the box is blank; say why rather than leave two dead buttons.
  return blank(field) ? `${base}+/- 需先填入数值。` : base
}
/**
 * `NumberField` clears to `undefined`; the field keeps holding `''` for blank so that
 * `paramsFromFields` drops the key instead of writing a value the session never chose.
 */
function setParam(field: ParamKey, value: number | undefined) {
  props.form[field] = value ?? ''
  emit('commit')
}
/** Restoring inheritance clears this field only; every other override stays untouched (spec §7.3). */
function restore(field: 'system_prompt' | 'temperature' | 'top_p' | 'max_tokens') {
  props.form[field] = ''
  emit('commit')
}
</script>

<template lang="pug">
Button(
  type="button" variant="ghost" size="sm" class="size-10 md:w-auto"
  aria-label="会话设置" :aria-expanded="open" aria-haspopup="dialog" @click="setOpen(true)")
  Settings2(data-icon="inline-start")
  span.hidden(class="md:inline") 会话设置
ResponsiveOverlay(:open="open" title="会话设置" @update:open="setOpen")
    FieldGroup(class="gap-4")
      Field(v-if="hasSession")
        FieldLabel(for="oc-session-title" class="text-xs") 标题
        Input(
          id="oc-session-title" v-model="form.title" class="h-8 text-sm" placeholder="对话标题"
          @change="emit('commit')")

      Field
        .flex.items-center.gap-2
          FieldLabel(for="oc-session-prompt" class="text-xs") 会话提示词
          Badge.ml-auto(variant="secondary") {{ BADGES[sources.system_prompt] }}
          Button(
            v-if="sources.system_prompt === 'session'" type="button" variant="ghost" size="icon-xs"
            title="恢复继承" aria-label="恢复继承会话提示词" @click="restore('system_prompt')")
            RotateCcw(data-icon="inline-start")
        Textarea(
          id="oc-session-prompt" v-model="form.system_prompt" rows="4" class="text-sm"
          placeholder="留空则只使用项目提示词" @change="emit('commit')")
        FieldDescription(class="text-xs") 项目提示词在前、会话提示词在后，中间固定两个换行。
        details.text-xs.text-muted-foreground(v-if="project?.system_prompt")
          summary.cursor-pointer 项目提示词
          pre.whitespace-pre-wrap.pt-1 {{ project.system_prompt }}

      Field
        .flex.items-center.gap-2
          FieldLabel(for="oc-session-temperature" class="text-xs") temperature
          Badge.ml-auto(variant="secondary") {{ BADGES[sources.temperature] }}
          Button(
            v-if="sources.temperature === 'session'" type="button" variant="ghost" size="icon-xs"
            title="恢复继承" aria-label="恢复继承 temperature" @click="restore('temperature')")
            RotateCcw(data-icon="inline-start")
        //- `step` sizes the +/- buttons only: `step-snapping` off is what lets a typed 0.85 stay
        //- 0.85 instead of being rewritten to the nearest 0.1, which is how the raw box behaved.
        //- `maximumFractionDigits` is 20, not a guess at what people type: a double carries at most
          //- 17 significant digits, so 20 fractional digits cannot lose one. reka round-trips every value
        //- through `Intl.NumberFormat`, whose default of 3 rewrote a stored 0.6667 to 0.667.
        NumberField(
          id="oc-session-temperature" :model-value="optionalNumber(form.temperature)"
          :min="0" :max="2" :step="0.1" :step-snapping="false" :disable-wheel-change="true"
          :format-options="{ maximumFractionDigits: 20 }"
          @update:model-value="setParam('temperature', $event)"
          @keydown.capture="guardStep('temperature', $event)"
          @wheel.capture="guardStep('temperature', $event)")
          NumberFieldContent
            NumberFieldDecrement(:disabled="blank('temperature')")
            NumberFieldInput(class="text-sm" @input="onType('temperature', $event)" @blur="onSettle('temperature')")
            NumberFieldIncrement(:disabled="blank('temperature')")
        FieldDescription(class="text-xs") {{ inheritHint('temperature', inherited?.temperature) }}

      Field
        .flex.items-center.gap-2
          FieldLabel(for="oc-session-top-p" class="text-xs") top_p
          Badge.ml-auto(variant="secondary") {{ BADGES[sources.top_p] }}
          Button(
            v-if="sources.top_p === 'session'" type="button" variant="ghost" size="icon-xs"
            title="恢复继承" aria-label="恢复继承 top_p" @click="restore('top_p')")
            RotateCcw(data-icon="inline-start")
        NumberField(
          id="oc-session-top-p" :model-value="optionalNumber(form.top_p)"
          :min="0" :max="1" :step="0.05" :step-snapping="false" :disable-wheel-change="true"
          :format-options="{ maximumFractionDigits: 20 }"
          @update:model-value="setParam('top_p', $event)"
          @keydown.capture="guardStep('top_p', $event)"
          @wheel.capture="guardStep('top_p', $event)")
          NumberFieldContent
            NumberFieldDecrement(:disabled="blank('top_p')")
            NumberFieldInput(class="text-sm" @input="onType('top_p', $event)" @blur="onSettle('top_p')")
            NumberFieldIncrement(:disabled="blank('top_p')")
        FieldDescription(class="text-xs") {{ inheritHint('top_p', inherited?.top_p) }}

      Field
        .flex.items-center.gap-2
          FieldLabel(for="oc-session-max-tokens" class="text-xs") 最大 tokens
          Badge.ml-auto(variant="secondary") {{ BADGES[sources.max_tokens] }}
          Button(
            v-if="sources.max_tokens === 'session'" type="button" variant="ghost" size="icon-xs"
            title="恢复继承" aria-label="恢复继承最大 tokens" @click="restore('max_tokens')")
            RotateCcw(data-icon="inline-start")
        NumberField(
          id="oc-session-max-tokens" :model-value="optionalNumber(form.max_tokens)"
          :min="1" :step="1" :step-snapping="false" :disable-wheel-change="true" :format-options="{ useGrouping: false }"
          @update:model-value="setParam('max_tokens', $event)"
          @keydown.capture="guardStep('max_tokens', $event)"
          @wheel.capture="guardStep('max_tokens', $event)")
          NumberFieldContent
            NumberFieldDecrement(:disabled="blank('max_tokens')")
            NumberFieldInput(class="text-sm" @input="onType('max_tokens', $event)" @blur="onSettle('max_tokens')")
            NumberFieldIncrement(:disabled="blank('max_tokens')")
        FieldDescription(class="text-xs") {{ inheritHint('max_tokens', inherited?.max_tokens) }}

      Field(v-if="!hasSession")
        FieldDescription(class="text-xs") 这些设置会随第一条消息一起创建会话。
</template>
