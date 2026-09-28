<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/client/lib/api'
import { useSiteConfigStore } from '@/client/stores/site-config'
import type { AdminSiteSettings } from '@/shared/auth'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Spinner } from '@/client/ui/spinner'
import { Checkbox } from '@/client/ui/checkbox'
import { Input } from '@/client/ui/input'
import { DEFAULT_UPLOAD_POLICY, UploadPolicySchema } from '@/shared/upload-policy'
import { FILE_EXTENSIONS, fileModality } from '@/shared/file-media'
import { Switch } from '@/client/ui/switch'

const siteConfig = useSiteConfigStore()
const settings = ref<AdminSiteSettings | null>(null)
const allowRegister = ref(false)
const maxSizeMiB = ref(20)
const allowedMimeTypes = ref<string[]>([])
const uploadDraft = computed(() => ({ maxBytes: maxSizeMiB.value * 1024 * 1024, allowedMimeTypes: allowedMimeTypes.value }))
const validUploads = computed(() => UploadPolicySchema.safeParse(uploadDraft.value).success)
const fileGroups = [
  { type: 'image', label: '图片' }, { type: 'pdf', label: 'PDF' },
  { type: 'audio', label: '音频' }, { type: 'video', label: '视频' },
].map(group => ({ ...group, formats: Object.entries(FILE_EXTENSIONS).filter(([mime]) => fileModality(mime) === group.type).map(([mime, ext]) => ({ mime, label: ext.toUpperCase() })) }))
function syncUploads() {
  if (!settings.value) return
  maxSizeMiB.value = settings.value.uploads.maxBytes / 1024 / 1024
  allowedMimeTypes.value = [...settings.value.uploads.allowedMimeTypes]
}
function toggleFormat(mime: string, checked: boolean) {
  allowedMimeTypes.value = checked ? [...new Set([...allowedMimeTypes.value, mime])] : allowedMimeTypes.value.filter(value => value !== mime)
}
const pending = ref(false)
const error = ref('')
const status = ref('')
const sourceLabels = { db: '站点设置', env: '部署配置', default: '默认配置' }
async function load() {
  pending.value = true
  error.value = ''
  try { settings.value = await api.adminSettings(); allowRegister.value = settings.value.allowRegister; syncUploads() }
  catch { error.value = '无法加载站点设置，请重试。' }
  finally { pending.value = false }
}
async function save(restore = false) {
  if (pending.value) return
  pending.value = true
  error.value = ''; status.value = ''
  try {
    settings.value = await api.updateAdminSettings({ allowRegister: restore ? null : allowRegister.value })
    allowRegister.value = settings.value.allowRegister
    await siteConfig.load(true)
    status.value = restore ? '已恢复部署配置' : '注册设置已保存'
  } catch { error.value = '无法保存注册设置，请重试。' }
  finally { pending.value = false }
}
async function saveUploads(restore = false) {
  if (pending.value || (!restore && !validUploads.value)) return
  pending.value = true
  error.value = ''; status.value = ''
  try {
    settings.value = await api.updateAdminSettings({ uploads: restore ? null : uploadDraft.value })
    syncUploads()
    await siteConfig.load(true)
    status.value = restore ? '已恢复默认上传设置' : '上传设置已保存'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '无法保存上传设置，请重试。' }
  finally { pending.value = false }
}
onMounted(load)
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 站点设置
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 站点设置
        p.text-sm.text-muted-foreground 管理注册权限、上传大小和允许的文件格式。
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
      Card(v-if="settings")
        CardHeader
          CardTitle 文件上传
          CardDescription 对新上传的文件生效，已有附件仍可访问。文件类型只控制上传，模型是否能读取取决于其能力。
        CardContent
          FieldGroup
            Field(:data-invalid="!validUploads || undefined")
              FieldLabel(for="upload-max-size") 单文件大小上限（MiB）
              Input#upload-max-size(v-model="maxSizeMiB" type="number" min="1" step="1" :disabled="pending" :aria-invalid="!validUploads || undefined")
              FieldDescription 默认 {{ DEFAULT_UPLOAD_POLICY.maxBytes / 1024 / 1024 }} MiB，实际上传仍受部署平台的请求大小限制。
            Field(v-for="group in fileGroups" :key="group.type")
              FieldLabel {{ group.label }}
              .flex.flex-wrap.gap-4
                Field(v-for="format in group.formats" :key="format.mime" orientation="horizontal" class="w-auto")
                  Checkbox(:id="`upload-${format.mime}`" :model-value="allowedMimeTypes.includes(format.mime)" :disabled="pending" @update:model-value="toggleFormat(format.mime, $event === true)")
                  FieldLabel(:for="`upload-${format.mime}`" class="font-normal") {{ format.label }}
            FieldDescription 不勾选任何格式时关闭文件上传。
        CardFooter(class="flex flex-wrap gap-2")
          Button(data-save-uploads :disabled="pending || !validUploads" @click="saveUploads()") 保存上传设置
          Button(variant="outline" :disabled="pending" @click="saveUploads(true)") 恢复默认上传设置
      Spinner(v-else-if="pending" aria-label="正在加载站点设置")
      Button(v-else variant="outline" @click="load") 重试
      p.text-sm.text-muted-foreground(v-if="status" role="status") {{ status }}
</template>
