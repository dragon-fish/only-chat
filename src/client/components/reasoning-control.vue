<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { Brain } from '@lucide/vue'
import { Button } from '@/client/ui/button'
import type { ButtonVariants } from '@/client/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/client/ui/tooltip'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/client/ui/drawer'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import { cn } from '@/client/lib/utils'
import ReasoningControls from '@/client/components/reasoning-controls.vue'
import {
  reasoningChipLabel,
  reasoningControlModel,
  reasoningDisabledReason,
  reasoningStopsFor,
} from '@/client/stores/sync'
import type { ReasoningChoice, ReasoningStop } from '@/client/stores/sync'
import type { ModelMetadata } from '@/shared/model-metadata'

/**
 * The reasoning controls as a chip that opens a responsive secondary overlay. This shape exists
 * for the Composer's toolbar, which has no room for three controls in a row. Anywhere with vertical
 * space to spare — a settings form — should render `reasoning-controls.vue` directly instead of
 * making the user open a layer to reach a single setting.
 */
const props = withDefaults(defineProps<{
  /** The chip's Button variant. Ghost suits the Composer's toolbar; a bordered host may use
   *  `outline` without styling the control through fallthrough attributes. */
  variant?: ButtonVariants['variant']
  metadata?: ModelMetadata | null
  stops?: ReasoningStop[] | null
  /** The effective choice, already resolved through Project inheritance by the parent. */
  active: ReasoningChoice
  /** True when the conversation overrides its Project, which is what surfaces the 默认 button. */
  overridden: boolean
  /** No model resolved yet — a different disabled reason from "this model cannot reason". */
  noModel: boolean
}>(), { variant: 'ghost', metadata: null, stops: null })
const emit = defineEmits<{ update: [choice: ReasoningChoice] }>()

const stops = computed(() => props.stops ?? reasoningStopsFor(props.metadata ?? undefined))
const model = computed(() => reasoningControlModel(stops.value, props.active))

/**
 * Spec §5.1: a control that cannot act says why; it never silently disappears. Only the first case
 * is the chip's own — a conversation with no resolved model has no capabilities to derive stops from,
 * which is a different statement from "this model cannot reason". The second comes from the shared
 * `reasoningDisabledReason`, which the body also renders, so the two hosts cannot drift apart.
 */
const disabledReason = computed(() => (
  props.noModel ? '先选择模型' : reasoningDisabledReason(stops.value)
))

const chipLabel = computed(() => reasoningChipLabel(model.value, props.active))

/**
 * The chip is `aria-disabled`, never `disabled`: the explanatory tooltip has to remain reachable,
 * and `InputGroup` would also grey the entire Composer card around a native disabled descendant.
 */
const open = ref(false)
const isDesktop = useMediaQuery('(min-width: 768px)')
const trigger = ref<InstanceType<typeof Button> | null>(null)
watch(isDesktop, async () => {
  if (!open.value) return
  open.value = false
  await nextTick()
  trigger.value?.$el.focus({ preventScroll: true })
})
function setOpen(next: boolean) {
  if (next && disabledReason.value !== null) return
  open.value = next
}
</script>

<template>
  <component :is="isDesktop ? Popover : Drawer" :open="open" @update:open="setOpen">
    <!-- Tooltip provides its own Popper context; keep the Popover anchor outside it. -->
    <PopoverAnchor v-if="isDesktop" :reference="trigger?.$el" class="hidden" />
    <Tooltip>
      <TooltipTrigger as-child>
        <component :is="isDesktop ? PopoverTrigger : DrawerTrigger" as-child>
          <Button
            ref="trigger"
            data-tour="reasoning"
            type="button"
            :variant="variant"
            size="xs"
            class="min-h-10 gap-1.5 aria-disabled:opacity-50 md:min-h-6"
            :aria-disabled="disabledReason !== null"
          >
            <Brain data-icon="inline-start" />
            <span class="text-xs">{{ chipLabel }}</span>
          </Button>
        </component>
      </TooltipTrigger>
      <TooltipContent>{{ disabledReason ?? '思考强度' }}</TooltipContent>
    </Tooltip>

    <component
      :is="isDesktop ? PopoverContent : DrawerContent"
      :side="isDesktop ? 'top' : undefined"
      :align="isDesktop ? 'end' : undefined"
      :side-offset="isDesktop ? 8 : undefined"
      aria-label="思考强度"
      :aria-describedby="undefined"
      :class="cn(isDesktop ? 'w-80' : 'overflow-hidden pb-[max(1rem,env(safe-area-inset-bottom))]')"
    >
      <DrawerHeader v-if="!isDesktop"><DrawerTitle>思考强度</DrawerTitle></DrawerHeader>
      <div :class="cn(!isDesktop && 'oc-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-4')">
        <ReasoningControls
          :metadata="metadata"
          :stops="stops"
          :active="active"
          :overridden="overridden"
          @update="emit('update', $event)"
        />
      </div>
    </component>
  </component>
</template>
