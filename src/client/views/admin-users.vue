<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { EllipsisIcon, PlusIcon } from '@lucide/vue'
import { authClient } from '@/client/lib/auth-client'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin, type AuthRole } from '@/shared/auth'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/client/ui/alert-dialog'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/client/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/client/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { Spinner } from '@/client/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'

type ManagedUser = NonNullable<Awaited<ReturnType<typeof authClient.admin.listUsers>>['data']>['users'][number]
type Action = 'role' | 'ban' | 'unban' | 'revoke'
const auth = useAuthStore()
const router = useRouter()
const users = shallowRef<ManagedUser[]>([])
const page = ref(0)
const total = ref(0)
const pageSize = 20
const loading = ref(false)
const pending = ref(false)
const error = ref('')
const status = ref('')
const formError = ref('')
const form = ref<'create' | 'password' | null>(null)
const selected = shallowRef<ManagedUser | null>(null)
const confirmation = ref<Action | null>(null)
const name = ref('')
const email = ref('')
const password = ref('')
const role = ref<AuthRole>('user')
const actionTitles = { role: '更改账户角色', ban: '封禁账户', unban: '解除封禁', revoke: '撤销全部登录会话' }
const nextRole = computed<AuthRole>(() => selected.value && isAuthAdmin(selected.value) ? 'user' : 'admin')
const confirmationDescription = computed(() => {
  if (confirmation.value === 'role') return `将此账户设为${nextRole.value === 'admin' ? '管理员，可管理本站账户与注册设置' : '普通用户'}。`
  if (confirmation.value === 'ban') return '此账户将无法登录，当前连接也会断开。'
  if (confirmation.value === 'unban') return '此账户将可以重新登录。'
  return '此账户在所有设备上的登录会话将失效，需要重新登录。'
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await authClient.admin.listUsers({ query: { limit: pageSize, offset: page.value * pageSize, sortBy: 'id', sortDirection: 'asc' } })
    if (result.error) throw new Error('list failed')
    users.value = result.data.users
    total.value = result.data.total
  } catch { error.value = '无法加载账户列表，请重试。' }
  finally { loading.value = false }
}
function movePage(direction: number) {
  if (loading.value || pending.value) return
  page.value += direction
  void load()
}
function openForm(kind: 'create' | 'password', user: ManagedUser | null = null) {
  selected.value = user
  name.value = ''; email.value = ''; password.value = ''; role.value = 'user'; formError.value = ''
  form.value = kind
}
function closeForm(open: boolean) {
  if (open || pending.value) return
  form.value = null
  password.value = ''
}
function selectRole(value: unknown) {
  if (value === 'user' || value === 'admin') role.value = value
}
function confirm(action: Action, user: ManagedUser) {
  selected.value = user
  confirmation.value = action
  formError.value = ''
}
function closeConfirmation(open: boolean) {
  if (!open && !pending.value) confirmation.value = null
}
async function submitForm() {
  if (pending.value) return
  pending.value = true; formError.value = ''; status.value = ''
  try {
    const result = form.value === 'create'
      ? await authClient.admin.createUser({ name: name.value.trim(), email: email.value.trim(), password: password.value, role: role.value })
      : await authClient.admin.setUserPassword({ userId: String(selected.value!.id), newPassword: password.value })
    if (result.error) { formError.value = '操作失败，请检查输入后重试。'; return }
    status.value = form.value === 'create' ? '账户已创建' : '密码已重设'
    form.value = null; password.value = ''
    await load()
  } catch { formError.value = '无法保存，请检查网络后重试。' }
  finally { pending.value = false }
}
async function performAction() {
  if (pending.value || !selected.value || !confirmation.value) return
  pending.value = true; formError.value = ''; status.value = ''
  const userId = String(selected.value.id)
  const action = confirmation.value
  try {
    const result = action === 'role' ? await authClient.admin.setRole({ userId, role: nextRole.value })
      : action === 'ban' ? await authClient.admin.banUser({ userId })
        : action === 'unban' ? await authClient.admin.unbanUser({ userId })
          : await authClient.admin.revokeUserSessions({ userId })
    if (result.error) { formError.value = '操作失败，请重试。'; return }
    confirmation.value = null
    status.value = '账户已更新'
    if (userId === String(auth.authUser?.id)) await auth.refresh(true)
    if (isAuthAdmin(auth.authUser)) await load()
    else if (auth.authUser) await router.replace('/new')
  } catch { formError.value = '无法更新账户，请检查网络后重试。' }
  finally { pending.value = false }
}
onMounted(load)
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header")
    SettingsBackButton
    span.truncate.text-sm.font-medium 用户管理
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-5xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-wrap.items-center.justify-between.gap-4
        .flex.flex-col.gap-2
          h1.text-2xl.font-semibold 用户管理
          p.text-sm.text-muted-foreground 管理账户、角色与登录权限。
        Button(:disabled="pending" @click="openForm('create')")
          PlusIcon(data-icon="inline-start")
          | 创建账户
      Alert(v-if="error" variant="destructive")
        AlertTitle 加载失败
        AlertDescription
          | {{ error }}
          Button(variant="link" :disabled="loading" @click="load") 重试
      p.text-sm.text-muted-foreground(v-if="status" role="status") {{ status }}
      Card
        CardHeader
          CardTitle 账户列表
          CardDescription 共 {{ total }} 个账户 · 站点所有者不能被封禁或降级。
        CardContent
          .flex.justify-center.py-8(v-if="loading")
            Spinner(aria-label="正在加载账户")
          Table(v-else-if="users.length")
            TableHeader
              TableRow
                TableHead 账户
                TableHead 角色
                TableHead 状态
                TableHead(class="hidden md:table-cell") 注册时间
                TableHead
                  span.sr-only 操作
            TableBody
              TableRow(v-for="user in users" :key="user.id")
                TableCell
                  .flex.min-w-0.flex-col.gap-1
                    span.max-w-48.truncate.font-medium {{ user.name }}
                    span.max-w-48.truncate.text-xs.text-muted-foreground {{ user.email }}
                TableCell
                  Badge(variant="secondary") {{ String(user.id) === '1' ? '所有者' : isAuthAdmin(user) ? '管理员' : '用户' }}
                TableCell
                  Badge(:variant="user.banned ? 'destructive' : 'outline'") {{ user.banned ? '已封禁' : '正常' }}
                TableCell(class="hidden md:table-cell") {{ new Date(user.createdAt).toLocaleDateString() }}
                TableCell
                  DropdownMenu
                    DropdownMenuTrigger(as-child)
                      Button(:data-user-actions="user.id" variant="ghost" size="icon" :aria-label="'管理 ' + user.name" :disabled="pending")
                        EllipsisIcon
                    DropdownMenuContent(align="end")
                      DropdownMenuGroup
                        DropdownMenuItem(data-set-role :disabled="String(user.id) === '1'" @select="confirm('role', user)") {{ isAuthAdmin(user) ? '设为普通用户' : '设为管理员' }}
                        DropdownMenuItem(@select="openForm('password', user)") 重设密码
                        DropdownMenuItem(@select="confirm('revoke', user)") 撤销全部登录会话
                      DropdownMenuSeparator
                      DropdownMenuGroup
                        DropdownMenuItem(v-if="user.banned" @select="confirm('unban', user)") 解除封禁
                        DropdownMenuItem(v-else data-ban-user variant="destructive" :disabled="String(user.id) === '1'" @select="confirm('ban', user)") 封禁账户
          Empty(v-else-if="!error")
            EmptyHeader
              EmptyTitle 暂无账户
              EmptyDescription 新创建的账户将显示在这里。
        CardFooter(class="flex flex-wrap items-center justify-between gap-3")
          span.text-sm.text-muted-foreground 第 {{ page + 1 }} 页
          .flex.gap-2
            Button(variant="outline" :disabled="loading || pending || page === 0" @click="movePage(-1)") 上一页
            Button(data-next-page variant="outline" :disabled="loading || pending || (page + 1) * pageSize >= total" @click="movePage(1)") 下一页
  Dialog(:open="form !== null" @update:open="closeForm")
    DialogContent(:show-close-button="!pending" @interact-outside="pending && $event.preventDefault()" @escape-key-down="pending && $event.preventDefault()")
      DialogHeader
        DialogTitle {{ form === 'create' ? '创建账户' : '重设密码' }}
        DialogDescription {{ form === 'create' ? '为新用户设置登录信息。' : selected?.email }}
      form.flex.flex-col.gap-6(@submit.prevent="submitForm")
        FieldGroup
          Alert(v-if="formError" variant="destructive")
            AlertTitle 操作失败
            AlertDescription {{ formError }}
          template(v-if="form === 'create'")
            Field
              FieldLabel(for="admin-name") 昵称
              Input#admin-name(v-model="name" required autocomplete="off" :disabled="pending")
            Field
              FieldLabel(for="admin-email") 邮箱
              Input#admin-email(v-model="email" required type="email" autocomplete="off" :disabled="pending")
            Field
              FieldLabel#admin-role 角色
              ToggleGroup(type="single" variant="outline" :model-value="role" aria-labelledby="admin-role" :disabled="pending" @update:model-value="selectRole")
                ToggleGroupItem(value="user") 普通用户
                ToggleGroupItem(value="admin") 管理员
          Field(:data-invalid="Boolean(formError)")
            FieldLabel(for="admin-password") {{ form === 'create' ? '初始密码' : '新密码' }}
            Input#admin-password(v-model="password" required type="password" minlength="8" maxlength="128" autocomplete="new-password" :disabled="pending" :aria-invalid="Boolean(formError)")
            FieldDescription 至少 8 个字符，请通过安全渠道告知用户。
        DialogFooter
          Button(type="button" variant="outline" :disabled="pending" @click="closeForm(false)") 取消
          Button(type="submit" :disabled="pending")
            Spinner(v-if="pending" data-icon="inline-start")
            | {{ form === 'create' ? '创建账户' : '重设密码' }}
  AlertDialog(:open="confirmation !== null" @update:open="closeConfirmation")
    AlertDialogContent(@escape-key-down="pending && $event.preventDefault()")
      AlertDialogHeader
        AlertDialogTitle {{ confirmation ? actionTitles[confirmation] : '' }}
        AlertDialogDescription {{ selected?.email }} · {{ confirmationDescription }}
      Alert(v-if="formError" variant="destructive")
        AlertTitle 操作失败
        AlertDescription {{ formError }}
      AlertDialogFooter
        AlertDialogCancel(:disabled="pending") 取消
        Button(:disabled="pending" :variant="confirmation === 'ban' ? 'destructive' : 'default'" @click="performAction")
          Spinner(v-if="pending" data-icon="inline-start")
          | 确认
</template>
