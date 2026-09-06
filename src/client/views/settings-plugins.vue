<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { Switch } from '@/client/ui/switch'
import { useSyncStore } from '@/client/stores/sync'

/** MVP ships no feature plugins; the list is driven by whatever keys exist in settings.plugins. */
const sync = useSyncStore()
function toggle(key: string, value: boolean) {
  sync.send({ type: 'settings.update', settings: { plugins: { [key]: value } } })
}
</script>

<template lang="pug">
//- Spec §8: the route root is fixed-height and clips; the body below is its only scroll owner.
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    RouterLink.shrink-0.text-muted-foreground(to="/settings/providers" class="hover:text-foreground") ←
    span.truncate.text-sm.font-medium 插件
  .oc-scroll.h-full.overflow-y-auto
    .max-w-2xl.p-4.flex.flex-col.gap-4
      p.text-sm.text-muted-foreground 功能插件会出现在这里，可以随时开关。当前版本尚未内置任何功能插件。
      ul.divide-y.rounded-md.border(v-if="Object.keys(sync.settings.plugins).length")
        li.flex.items-center.gap-3.p-3(v-for="(on, key) in sync.settings.plugins" :key="key")
          span {{ key }}
          Switch(class="ml-auto" :model-value="on" @update:model-value="toggle(String(key), $event)")
</template>
