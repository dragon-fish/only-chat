<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { Avatar, AvatarFallback } from '@/client/ui/avatar'

const props = withDefaults(defineProps<{ labId: string | null; providerName: string; size?: 'sm' | 'default' }>(), { size: 'default' })
const sourceIndex = ref(0)
const sources = computed(() => {
  if (!props.labId) return []
  const id = encodeURIComponent(props.labId)
  return [
    `https://api.iconify.design/logos:${id}-icon.svg`,
    `https://api.iconify.design/logos:${id}.svg`,
    `https://models.dev/logos/labs/${id}.svg`,
  ]
})
const failed = computed(() => sourceIndex.value >= sources.value.length)
watch(() => props.labId, () => { sourceIndex.value = 0 })
</script>

<template lang="pug">
ProviderAvatar(v-if="!labId || failed" :name="providerName" :size="size")
Avatar(v-else :size="size" :aria-label="labId")
  img.size-full.object-contain(:src="sources[sourceIndex]" :alt="labId" loading="lazy" @error="sourceIndex++")
  AvatarFallback(class="sr-only") {{ providerName }}
</template>
