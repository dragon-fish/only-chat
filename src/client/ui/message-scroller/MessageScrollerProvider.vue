<script setup lang="ts">
import type { MessageScrollerProviderProps } from './useMessageScroller'
import { provideMessageScroller } from './useMessageScroller'

const props = defineProps<MessageScrollerProviderProps>()

const engine = provideMessageScroller(props)

defineExpose({ scrollToMessage: engine.context.scrollToMessage })
</script>

<template>
  <slot />
</template>
