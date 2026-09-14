<script setup lang="ts">
import { ref, watch } from 'vue'
import { authClient } from '@/client/lib/auth-client'
import { useAuthStore } from '@/client/stores/auth'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Spinner } from '@/client/ui/spinner'

const auth = useAuthStore()
const name = ref(auth.authUser?.name ?? '')
const currentPassword = ref('')
const newPassword = ref('')
const pending = ref<'profile' | 'password' | 'signout' | null>(null)
const error = ref('')
const status = ref('')
watch(() => auth.authUser?.name, value => { name.value = value ?? '' })

async function signOut() {
  if (pending.value) return
  pending.value = 'signout'
  error.value = ''; status.value = ''
  try { await auth.signOut() }
  catch { error.value = '退出登录失败，请重试。' }
  finally { pending.value = null }
}

async function save(kind: 'profile' | 'password') {
  if (pending.value) return
  pending.value = kind
  error.value = ''
  status.value = ''
  try {
    const result = kind === 'profile'
      ? await authClient.updateUser({ name: name.value.trim() })
      : await authClient.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value, revokeOtherSessions: true })
    if (result.error) {
      error.value = kind === 'password' ? '密码修改失败，请检查当前密码和新密码。' : '昵称保存失败，请重试。'
      return
    }
    if (kind === 'password') { currentPassword.value = ''; newPassword.value = '' }
    await auth.refresh(true)
    status.value = kind === 'profile' ? '昵称已更新' : '密码已更新，其他设备已退出登录'
  } catch { error.value = '无法保存，请检查网络后重试。' }
  finally { pending.value = null }
}
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 账户
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 账户
        p.text-sm.text-muted-foreground 管理你的个人信息与登录密码。
      Alert(v-if="error" variant="destructive")
        AlertTitle 保存失败
        AlertDescription {{ error }}
      p.text-sm.text-muted-foreground(v-if="status" role="status") {{ status }}
      form(data-profile-form @submit.prevent="save('profile')")
        Card
          CardHeader
            CardTitle 个人信息
            CardDescription 昵称会显示在账户菜单中。
          CardContent
            FieldGroup
              Field
                FieldLabel(for="account-name") 昵称
                Input#account-name(v-model="name" required autocomplete="name" :disabled="Boolean(pending)")
              Field
                FieldLabel(for="account-email") 邮箱
                Input#account-email(:model-value="auth.authUser?.email ?? ''" readonly type="email" autocomplete="email")
                FieldDescription 邮箱用于登录，暂不支持修改。
          CardFooter
            Button(type="submit" :disabled="Boolean(pending) || !name.trim()")
              Spinner(v-if="pending === 'profile'" data-icon="inline-start")
              | 保存昵称
      form(data-password-form @submit.prevent="save('password')")
        Card
          CardHeader
            CardTitle 修改密码
            CardDescription 修改后，其他设备需要重新登录。
          CardContent
            FieldGroup
              Field(:data-invalid="Boolean(error)")
                FieldLabel(for="current-password") 当前密码
                Input#current-password(v-model="currentPassword" type="password" required autocomplete="current-password" :disabled="Boolean(pending)" :aria-invalid="Boolean(error)")
              Field(:data-invalid="Boolean(error)")
                FieldLabel(for="new-password") 新密码
                Input#new-password(v-model="newPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password" :disabled="Boolean(pending)" :aria-invalid="Boolean(error)")
                FieldDescription 使用至少 8 个字符。
          CardFooter
            Button(type="submit" :disabled="Boolean(pending)")
              Spinner(v-if="pending === 'password'" data-icon="inline-start")
              | 更新密码
      Button(data-account-sign-out variant="outline" class="self-start" :disabled="Boolean(pending)" @click="signOut")
        Spinner(v-if="pending === 'signout'" data-icon="inline-start")
        | 退出登录
</template>
