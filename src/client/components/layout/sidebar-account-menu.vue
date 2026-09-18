<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronsUpDownIcon, CircleUserRoundIcon, LogOutIcon, ShieldCogCornerIcon, UserRoundIcon, UserCogIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin } from '@/shared/auth'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/ui/avatar'
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/client/ui/sidebar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/client/ui/dropdown-menu'

const auth = useAuthStore()
const admin = computed(() => isAuthAdmin(auth.authUser))
const pending = ref(false)
async function signOut() {
  if (pending.value) return
  pending.value = true
  try { await auth.signOut() }
  catch { toast.error('退出登录失败，请重试') }
  finally { pending.value = false }
}
</script>

<template lang="pug">
SidebarMenu(v-if="auth.authUser")
  SidebarMenuItem
    DropdownMenu
      DropdownMenuTrigger(as-child)
        SidebarMenuButton(data-account-menu size="lg" tooltip="账户")
          Avatar
            AvatarImage(v-if="auth.authUser.image" :src="auth.authUser.image" :alt="auth.authUser.name")
            AvatarFallback
              CircleUserRoundIcon
          span.min-w-0.flex-1.text-left(class="group-data-[collapsible=icon]:hidden")
            span.block.truncate.font-medium {{ auth.authUser.name }}
            span.block.truncate.text-xs.text-muted-foreground {{ auth.authUser.email }}
          ChevronsUpDownIcon(class="group-data-[collapsible=icon]:hidden")
      DropdownMenuContent(side="top" align="start" class="w-60")
        DropdownMenuGroup
          DropdownMenuItem(as-child)
            RouterLink(to="/me")
              UserRoundIcon
              | 个人资料
          DropdownMenuItem(as-child)
            RouterLink(to="/settings/account")
              UserCogIcon
              | 账户设置
          DropdownMenuItem(v-if="admin" as-child)
            RouterLink(to="/admin/users")
              ShieldCogCornerIcon
              | 站点管理
        DropdownMenuSeparator
        DropdownMenuGroup
          DropdownMenuItem(data-sign-out :disabled="pending" @select="signOut")
            LogOutIcon
            | 退出登录
</template>
