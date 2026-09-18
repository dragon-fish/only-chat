<script setup lang="ts">
import { SidebarMenu, SidebarMenuItem, SidebarMenuSkeleton } from '@/client/ui/sidebar'

/** Rows the size of the nav rows they stand in for, so nothing jumps when the list arrives. */
withDefaults(defineProps<{ count?: number }>(), { count: 5 })
</script>

<template lang="pug">
SidebarMenu
  SidebarMenuItem(v-for="index in count" :key="index")
    SidebarMenuSkeleton(show-icon class="min-h-10 md:min-h-0")
</template>
