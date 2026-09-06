<script setup lang="ts">
import { computed, ref } from 'vue'
import { Brain } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import type { ButtonVariants } from '@/client/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import ReasoningControls from '@/client/components/reasoning-controls.vue'
import {
  reasoningChipLabel,
  reasoningControlModel,
  reasoningDisabledReason,
  reasoningStopsFor,
} from '@/client/stores/sync'
import type { ReasoningChoice, ReasoningStop } from '@/client/stores/sync'
import type { ModelCapabilities, Protocol } from '@/shared/models'

/**
 * The reasoning controls as a chip that opens a popover. This shape exists for the Composer's
 * toolbar, which has no room for three controls in a row. Anywhere with vertical space to spare —
 * a settings form — should render `reasoning-controls.vue` directly instead of making the user
 * open a layer to reach a single setting.
 */
const props = withDefaults(defineProps<{
  /** The chip's Button variant. Ghost suits the Composer's toolbar; a bordered form needs
   *  `outline`, and a fallthrough `class` cannot supply it because `Popover` is renderless. */
  variant?: ButtonVariants['variant']
  capabilities?: ModelCapabilities | null
  protocol?: Protocol | null
  stops?: ReasoningStop[] | null
  /** The effective choice, already resolved through Project inheritance by the parent. */
  active: ReasoningChoice
  /** True when the session overrides its Project, which is what surfaces the 默认 button. */
  overridden: boolean
  /** No model resolved yet — a different disabled reason from "this model cannot reason". */
  noModel: boolean
}>(), { variant: 'ghost', capabilities: null, protocol: null, stops: null })
const emit = defineEmits<{ update: [choice: ReasoningChoice] }>()

const stops = computed(() => props.stops ?? (props.capabilities && props.protocol
  ? reasoningStopsFor(props.capabilities, props.protocol)
  : []))
const model = computed(() => reasoningControlModel(stops.value, props.active))

/**
 * Spec §5.1: a control that cannot act says why; it never silently disappears. Only the first case
 * is the chip's own — a session with no resolved model has no capabilities to derive stops from,
 * which is a different statement from "this model cannot reason". The second comes from the shared
 * `reasoningDisabledReason`, which the body also renders, so the two hosts cannot drift apart.
 */
const disabledReason = computed(() => (
  props.noModel ? '先选择模型' : reasoningDisabledReason(stops.value)
))

const chipLabel = computed(() => reasoningChipLabel(model.value, props.active))

/**
 * The chip is `aria-disabled`, never `disabled`: `InputGroup` carries `has-disabled:opacity-50`,
 * which compiles to `:has(*:disabled)` and would grey the entire Composer card around it. So the
 * popover is opened through a guarded handler rather than by the trigger alone.
 */
const open = ref(false)
function setOpen(next: boolean) {
  if (next && disabledReason.value !== null) return
  open.value = next
}
</script>

<template>
  <Popover :open="open" @update:open="setOpen">
    <PopoverTrigger as-child>
      <Button
        type="button"
        :variant="variant"
        size="xs"
        class="gap-1.5 aria-disabled:opacity-50"
        :aria-disabled="disabledReason !== null"
        :title="disabledReason ?? '思考强度'"
      >
        <Brain data-icon="inline-start" />
        <span class="text-xs">{{ chipLabel }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80">
      <ReasoningControls
        :capabilities="capabilities"
        :protocol="protocol"
        :stops="stops"
        :active="active"
        :overridden="overridden"
        @update="emit('update', $event)"
      />
    </PopoverContent>
  </Popover>
</template>
