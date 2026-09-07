<script setup lang="ts">
import { ref, watch } from 'vue'
import ProviderAvatar from '@/client/components/provider-avatar.vue'
import { Avatar, AvatarFallback } from '@/client/ui/avatar'

const props = withDefaults(defineProps<{ labId: string | null; providerName: string; size?: 'sm' | 'default' }>(), { size: 'default' })
const failed = ref(false)
watch(() => props.labId, () => { failed.value = false })
</script>

<template lang="pug">
ProviderAvatar(v-if="!labId || failed" :name="providerName" :size="size")
Avatar(v-else :size="size" :aria-label="labId")
  img.size-full.object-contain(:src="`https://models.dev/logos/labs/${encodeURIComponent(labId)}.svg`" :alt="labId" loading="lazy" @error="failed = true")
  AvatarFallback(class="sr-only") {{ providerName }}
</template>
