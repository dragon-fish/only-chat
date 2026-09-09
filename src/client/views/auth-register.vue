<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { CircleAlertIcon } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { authClient, authErrorMessage } from '@/client/lib/auth-client'
import { validatedRelativeRedirect } from '@/client/router'
import { useAuthStore } from '@/client/stores/auth'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Spinner } from '@/client/ui/spinner'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const allowRegister = ref<boolean | null>(null)
const settingsError = ref(false)
const name = ref('')
const email = ref('')
const password = ref('')
const pending = ref(false)
const errorMessage = ref('')
const loginLocation = computed(() => {
  const redirect = validatedRelativeRedirect(route.query.redirect)
  return redirect ? { path: '/login', query: { redirect } } : '/login'
})

async function loadSiteSettings() {
  allowRegister.value = null
  settingsError.value = false
  try {
    allowRegister.value = (await api.siteSettings()).allowRegister
  } catch {
    settingsError.value = true
  }
}

async function submit() {
  if (pending.value || allowRegister.value !== true) return
  pending.value = true
  errorMessage.value = ''
  try {
    const result = await authClient.signUp.email({ name: name.value.trim(), email: email.value.trim(), password: password.value })
    if (result.error) {
      errorMessage.value = authErrorMessage(result.error, 'register')
      return
    }
    await auth.refresh(true)
    if (!auth.authUser) {
      errorMessage.value = '注册失败，请稍后重试'
      return
    }
    await router.replace(validatedRelativeRedirect(route.query.redirect) ?? '/new')
  } catch (error) {
    errorMessage.value = authErrorMessage(error, 'register')
  } finally {
    pending.value = false
  }
}

onMounted(loadSiteSettings)
</script>

<template lang="pug">
main.flex.min-h-dvh.items-center.justify-center.bg-background.p-4
  Card.w-full.max-w-sm(v-if="allowRegister === null")
    CardHeader
      CardTitle 创建账号
      CardDescription 正在确认本站注册设置。
    CardContent.flex.justify-center.py-6
      Alert(v-if="settingsError" variant="destructive")
        CircleAlertIcon
        AlertTitle 无法加载注册设置
        AlertDescription 请检查网络后重试。
      Spinner(v-else aria-label="正在加载")
    CardFooter
      Button.w-full(v-if="settingsError" type="button" variant="outline" @click="loadSiteSettings") 重试
  Card.w-full.max-w-sm(v-else-if="!allowRegister")
    CardHeader
      CardTitle 注册未开放
      CardDescription 当前站点暂不接受新账号注册。
    CardContent
      Alert
        AlertTitle 已有账号？
        AlertDescription 你仍然可以使用现有账号登录。
    CardFooter
      Button.w-full(as-child)
        RouterLink(:to="loginLocation") 返回登录
  form.w-full.max-w-sm(v-else @submit.prevent="submit")
    Card
      CardHeader
        CardTitle 创建账号
        CardDescription 填写基本信息即可开始使用 Only Chat。
      CardContent
        FieldGroup
          Alert(v-if="errorMessage" variant="destructive")
            CircleAlertIcon
            AlertTitle 注册失败
            AlertDescription {{ errorMessage }}
          Field(:data-invalid="Boolean(errorMessage)")
            FieldLabel(for="register-name") 昵称
            Input#register-name(v-model="name" autocomplete="name" required :aria-invalid="Boolean(errorMessage)" :disabled="pending")
          Field(:data-invalid="Boolean(errorMessage)")
            FieldLabel(for="register-email") 邮箱
            Input#register-email(v-model="email" type="email" autocomplete="email" placeholder="you@example.com" required :aria-invalid="Boolean(errorMessage)" :disabled="pending")
          Field(:data-invalid="Boolean(errorMessage)")
            FieldLabel(for="register-password") 密码
            Input#register-password(v-model="password" type="password" autocomplete="new-password" minlength="8" required :aria-invalid="Boolean(errorMessage)" :disabled="pending")
      CardFooter(class="flex flex-col gap-3")
        Button.w-full(type="submit" :disabled="pending")
          Spinner(v-if="pending" data-icon="inline-start")
          | {{ pending ? '正在注册' : '注册' }}
        p.text-center.text-sm.text-muted-foreground
          | 已有账号？
          RouterLink.ml-1.text-foreground.underline-offset-4(:to="loginLocation" class="hover:underline") 登录
</template>
