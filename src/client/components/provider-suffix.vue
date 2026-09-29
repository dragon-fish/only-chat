<script setup lang="ts">
defineProps<{ name: string }>()
</script>

<template lang="pug">
//- The model name beside it must be shrink-0: sharing the squeeze even by a fraction of a pixel
//- truncates the name, and the name is the part that has to stay readable.
span(class="flex min-w-0 text-xs font-normal text-muted-foreground")
  span.shrink-0 {{ '(' }}
  span.truncate {{ name }}
  span.shrink-0 {{ ')' }}
</template>
