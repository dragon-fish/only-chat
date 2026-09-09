<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronsUpDownIcon, CircleUserRoundIcon, LogOutIcon, ShieldIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin } from '@/shared/auth'
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
          CircleUserRoundIcon
          span.min-w-0.flex-1.text-left(class="group-data-[collapsible=icon]:hidden")
            span.block.truncate.font-medium {{ auth.authUser.name }}
            span.block.truncate.text-xs.text-muted-foreground {{ auth.authUser.email }}
          ChevronsUpDownIcon(class="group-data-[collapsible=icon]:hidden")
      DropdownMenuContent(side="top" align="start" class="w-60")
        DropdownMenuGroup
          DropdownMenuItem(as-child)
            RouterLink(to="/settings/account")
              CircleUserRoundIcon
              | 账户设置
          DropdownMenuItem(v-if="admin" as-child)
            RouterLink(to="/admin/users")
              ShieldIcon
              | 站点管理
        DropdownMenuSeparator
        DropdownMenuGroup
          DropdownMenuItem(data-sign-out :disabled="pending" @select="signOut")
            LogOutIcon
            | 退出登录
</template>
