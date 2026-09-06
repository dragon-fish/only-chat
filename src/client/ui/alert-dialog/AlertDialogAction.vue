<script setup lang="ts">
import type { AlertDialogActionProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { ButtonVariants } from '@/client/ui/button'
import { reactiveOmit } from '@vueuse/core'
import { AlertDialogAction } from 'reka-ui'
import { cn } from '@/client/lib/utils'
import { buttonVariants } from '@/client/ui/button'

const props = withDefaults(
  defineProps<AlertDialogActionProps & {
    class?: HTMLAttributes['class']
    variant?: ButtonVariants['variant']
    size?: ButtonVariants['size']
  }>(),
  {
    variant: 'default',
    size: 'default',
  },
)

const delegatedProps = reactiveOmit(props, 'class', 'variant', 'size')
</script>

<template>
  <AlertDialogAction
    data-slot="alert-dialog-action"
    v-bind="delegatedProps"
    :class="cn('', buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </AlertDialogAction>
</template>
