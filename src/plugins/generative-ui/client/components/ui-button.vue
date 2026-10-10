<script setup lang="ts">
// Click handling follows OpenUI's `react-ui/src/genui-lib/Button/index.tsx`.
// Adapted from OpenUI (https://github.com/thesysdev/openui), Copyright (c) 2011-2024 Thesys Inc., MIT License. See NOTICE.md.
import { computed } from 'vue'
import { ACTION_STEPS, type ActionPlan } from '@openuidev/lang-core'
import { useFormName, useFormValidation, useIsStreaming, useTriggerAction } from '@openuidev/vue-lang'
import { Button } from '@/client/ui/button'
import { messagesAssistant, useGenerativeUiHost, type NodeProps } from '../runtime'

const { props } = defineProps<NodeProps<{ label?: string, action?: unknown, variant?: 'primary' | 'secondary' | 'ghost' }>>()
const triggerAction = useTriggerAction()
const formName = useFormName()
const validation = useFormValidation()
const streaming = useIsStreaming()
const host = useGenerativeUiHost()
const VARIANT = { primary: 'default', secondary: 'outline', ghost: 'ghost' } as const
const reachesAssistant = computed(() => messagesAssistant(props.action))
const disabled = computed(() => streaming.value || (reachesAssistant.value && !host.canMessage.value))

function click() {
  if (disabled.value) return
  const action = props.action as ActionPlan | undefined
  // Ported from OpenUI's Button: a form is validated only when the click would send it somewhere.
  if (validation && (props.variant ?? 'primary') === 'primary') {
    const sends = action?.steps ? action.steps.some(step => step.type === ACTION_STEPS.ToAssistant) : true
    if (sends && !validation.validateForm()) return
  }
  triggerAction(String(props.label ?? ''), formName?.value, action as never)
}
</script>

<template lang="pug">
Button(
  type="button" :variant="VARIANT[props.variant ?? 'primary'] ?? 'default'" :disabled="disabled"
  class="min-h-10 max-w-full whitespace-normal md:min-h-8" @click="click") {{ props.label }}
</template>
