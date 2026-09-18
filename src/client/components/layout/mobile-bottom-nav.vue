<script setup lang="ts">
import { CircleUserRoundIcon, ImagesIcon, MessageCircleIcon, PlusIcon, SettingsIcon } from '@lucide/vue'
import { RouterLink, useRoute } from 'vue-router'
import { Button } from '@/client/ui/button'

/** Two either side of the compose button, which is what puts it in the middle of the bar. */
const tabs = [
  { to: '/chats', label: '聊天', icon: MessageCircleIcon },
  { to: '/images', label: '图片', icon: ImagesIcon },
  { to: '/settings', label: '设置', icon: SettingsIcon },
  { to: '/me', label: '我的', icon: CircleUserRoundIcon },
]

const route = useRoute()
const isActive = (to: string) => route.path === to || route.path.startsWith(`${to}/`)

// Decided here rather than through `active-class`: the ghost variant also sets a text colour, and
// with both classes on one element the winner is CSS source order, not the order they are written.
//
// The fill is tinted, not solid. These are stroke icons with no solid variant, and filling one
// outright erases what is drawn inside it — a filled CircleUserRound is a black disc with no person
// in it. A light fill behind the stroke reads as "on" while the glyph stays legible.
// Four signals rather than one: the pill alone was too quiet to find at a glance, and replacing it
// with colour would have traded one lone signal for another. They stack.
const ACTIVE = 'bg-accent text-primary font-medium [&>svg]:fill-primary/20'
const INACTIVE = 'text-muted-foreground'
</script>

<template>
  <nav
    aria-label="主要导航"
    class="oc-mobile-nav absolute inset-x-0 bottom-0 flex items-center justify-around border-t bg-background px-4 pt-2 md:hidden"
  >
    <Button
      v-for="tab in tabs.slice(0, 2)" :key="tab.to"
      as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1"
    >
      <RouterLink :to="tab.to" :class="isActive(tab.to) ? ACTIVE : INACTIVE">
        <component :is="tab.icon" />
        <span class="text-xs">{{ tab.label }}</span>
      </RouterLink>
    </Button>
    <!--
      Breaks the top edge rather than sitting inside it, and is the one control here that makes
      something rather than goes somewhere. Bottom-aligned with the labels: raising the whole disc
      would lift its base off their line. The border needs nothing to interrupt it — an opaque disc
      already does, and a ring in the bar's colour only opens a gap around it.
    -->
    <Button
      as-child size="icon-lg"
      class="size-16 self-end -mt-10 mb-1 rounded-full shadow-lg"
    >
      <RouterLink to="/new" aria-label="开始随心聊">
        <!-- Sized on the icon, not the button: the variant only yields to an svg carrying its own
             size class, so a size set from the parent's selector loses to the default. -->
        <PlusIcon class="size-7" />
      </RouterLink>
    </Button>
    <Button
      v-for="tab in tabs.slice(2)" :key="tab.to"
      as-child variant="ghost" class="h-auto min-h-10 min-w-16 flex-col gap-1 py-1"
    >
      <RouterLink :to="tab.to" :class="isActive(tab.to) ? ACTIVE : INACTIVE">
        <component :is="tab.icon" />
        <span class="text-xs">{{ tab.label }}</span>
      </RouterLink>
    </Button>
  </nav>
</template>
