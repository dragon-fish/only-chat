<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { lobeModelIconSources } from '@/client/lib/model-icons'
import { Avatar, AvatarFallback } from '@/client/ui/avatar'

const props = withDefaults(defineProps<{
  labId: string | null
  providerName: string
  modelId?: string | null
  family?: string | null
  size?: 'sm' | 'default'
}>(), { modelId: null, family: null, size: 'default' })
const sourceIndex = ref(0)
const sources = computed(() => {
  const result = lobeModelIconSources(props)
  if (!props.labId) return result
  const id = encodeURIComponent(props.labId)
  result.push(
    `https://api.iconify.design/logos:${id}-icon.svg`,
    `https://api.iconify.design/logos:${id}.svg`,
    `https://models.dev/logos/labs/${id}.svg`,
  )
  return [...new Set(result)]
})
const failed = computed(() => sourceIndex.value >= sources.value.length)
watch(() => [props.modelId, props.labId, props.family], () => { sourceIndex.value = 0 })
</script>

<template lang="pug">
ProviderAvatar(v-if="failed" :name="providerName" :size="size")
Avatar(v-else :size="size" :aria-label="labId ?? family ?? providerName")
  img.size-full.object-contain.p-1(:src="sources[sourceIndex]" :alt="labId ?? family ?? providerName" loading="lazy" @error="sourceIndex++")
  AvatarFallback(class="sr-only") {{ providerName }}
</template>
