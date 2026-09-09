<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/client/lib/api'
import type { AdminSiteSettings } from '@/shared/auth'
import SettingsBackButton from '@/client/components/layout/settings-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Spinner } from '@/client/ui/spinner'
import { Switch } from '@/client/ui/switch'

const settings = ref<AdminSiteSettings | null>(null)
const allowRegister = ref(false)
const pending = ref(false)
const error = ref('')
const status = ref('')
const sourceLabels = { db: '站点设置', env: '部署配置', default: '默认配置' }
async function load() {
  pending.value = true
  error.value = ''
  try { settings.value = await api.adminSettings(); allowRegister.value = settings.value.allowRegister }
  catch { error.value = '无法加载注册设置，请重试。' }
  finally { pending.value = false }
}
async function save(restore = false) {
  if (pending.value) return
  pending.value = true
  error.value = ''; status.value = ''
  try {
    settings.value = await api.updateAdminSettings({ allowRegister: restore ? null : allowRegister.value })
    allowRegister.value = settings.value.allowRegister
    await api.siteSettings()
    status.value = restore ? '已恢复部署配置' : '注册设置已保存'
  } catch { error.value = '无法保存注册设置，请重试。' }
  finally { pending.value = false }
}
onMounted(load)
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    SettingsBackButton
    span.truncate.text-sm.font-medium 注册设置
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 注册设置
        p.text-sm.text-muted-foreground 决定新用户是否可以自行创建账户。
      Alert(v-if="error" variant="destructive")
        AlertTitle 操作失败
        AlertDescription {{ error }}
      Card(v-if="settings")
        CardHeader
          CardTitle 开放注册
          CardDescription 关闭注册不影响已有用户登录，管理员仍可创建账户。
        CardContent
          FieldGroup
            Field(orientation="horizontal")
              FieldContent
                FieldLabel(for="allow-register") 允许新用户注册
                FieldDescription 当前生效：{{ settings.allowRegister ? '开放' : '关闭' }}
              Switch#allow-register(v-model="allowRegister" :disabled="pending")
            Field
              FieldDescription
                | 配置来源：
                Badge(variant="secondary") {{ sourceLabels[settings.source] }}
        CardFooter(class="flex flex-wrap gap-2")
          Button(data-save-settings :disabled="pending" @click="save()")
            Spinner(v-if="pending" data-icon="inline-start")
            | 保存设置
          Button(data-restore-settings variant="outline" :disabled="pending || settings.source !== 'db'" @click="save(true)") 恢复部署配置
      Spinner(v-else-if="pending" aria-label="正在加载注册设置")
      Button(v-else variant="outline" @click="load") 重试
      p.text-sm.text-muted-foreground(v-if="status" role="status") {{ status }}
</template>
