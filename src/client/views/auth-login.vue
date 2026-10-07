<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { CircleAlertIcon } from '@lucide/vue'
import { useSiteConfigStore } from '@/client/stores/site-config'
import { authClient, authErrorMessage } from '@/client/lib/auth-client'
import { validatedRelativeRedirect } from '@/client/router'
import { useAuthStore } from '@/client/stores/auth'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Checkbox } from '@/client/ui/checkbox'
import { Spinner } from '@/client/ui/spinner'

const siteConfig = useSiteConfigStore()
const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const email = ref('')
const password = ref('')
const rememberMe = ref(true)
const allowRegister = ref(false)
const pending = ref(false)
const errorMessage = ref('')
const registerLocation = computed(() => {
  const redirect = validatedRelativeRedirect(route.query.redirect)
  return redirect ? { path: '/register', query: { redirect } } : '/register'
})

async function submit() {
  if (pending.value) return
  pending.value = true
  errorMessage.value = ''
  try {
    const result = await authClient.signIn.email({ email: email.value.trim(), password: password.value, rememberMe: rememberMe.value })
    if (result.error) {
      errorMessage.value = authErrorMessage(result.error, 'login')
      return
    }
    await auth.refresh(true)
    if (!auth.authUser) {
      errorMessage.value = '登录失败，请稍后重试'
      return
    }
    await router.replace(validatedRelativeRedirect(route.query.redirect) ?? '/new')
  } catch (error) {
    errorMessage.value = authErrorMessage(error, 'login')
  } finally {
    pending.value = false
  }
}
onMounted(async () => {
  try { allowRegister.value = (await siteConfig.load()).allowRegister }
  catch { allowRegister.value = false }
})
</script>

<template lang="pug">
main.flex.min-h-dvh.items-center.justify-center.bg-background.p-4
  form.w-full.max-w-sm(@submit.prevent="submit")
    Card
      CardHeader
        CardTitle 登录 Only Chat
        CardDescription 使用你的邮箱继续。
      CardContent
        FieldGroup
          Alert(v-if="errorMessage" variant="destructive")
            CircleAlertIcon
            AlertTitle 登录失败
            AlertDescription {{ errorMessage }}
          Field(:data-invalid="Boolean(errorMessage)")
            FieldLabel(for="login-email") 邮箱
            Input#login-email(v-model="email" type="email" autocomplete="email" placeholder="you@example.com" required :aria-invalid="Boolean(errorMessage)" :disabled="pending")
          Field(:data-invalid="Boolean(errorMessage)")
            FieldLabel(for="login-password") 密码
            Input#login-password(v-model="password" type="password" autocomplete="current-password" required :aria-invalid="Boolean(errorMessage)" :disabled="pending")
          Field(orientation="horizontal" :data-disabled="pending")
            Checkbox#login-remember(v-model="rememberMe" :disabled="pending")
            FieldLabel(for="login-remember") 记住登录
      CardFooter(class="flex flex-col gap-3")
        Button.w-full(type="submit" :disabled="pending")
          Spinner(v-if="pending" data-icon="inline-start")
          | {{ pending ? '正在登录' : '登录' }}
        p.text-center.text-sm.text-muted-foreground(v-if="allowRegister")
          | 还没有账号？
          RouterLink.ml-1.text-foreground.underline-offset-4(:to="registerLocation" class="hover:underline") 注册
        //- A plain link, not a RouterLink: the demo is a separate page with its own app.
        p.text-center.text-sm.text-muted-foreground
          | 想先看看？
          a.ml-1.text-foreground.underline-offset-4(href="/demo/" class="hover:underline") 先体验一下
</template>
