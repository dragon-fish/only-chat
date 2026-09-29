<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { KeyRoundIcon, Trash2Icon, TriangleAlertIcon } from '@lucide/vue'
import { toast } from 'vue-sonner'
import { api } from '@/client/lib/api'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/client/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Switch } from '@/client/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/client/ui/tabs'
import type { McpHeaderInput, McpServerView, McpTransport } from '@/shared/mcp'
import HeadersEditor from './headers-editor.vue'
import ToolsPanel from './tools-panel.vue'
import { OAUTH_CHANNEL, STATUS_LABELS, statusVariant, TRANSPORT_LABELS } from './format'

/** `null` is the form for a new server. */
const props = defineProps<{ server: McpServerView | null }>()
const emit = defineEmits<{ saved: [server: McpServerView], deleted: [], back: [] }>()

const tab = ref<'general' | 'tools'>('general')
const name = ref(props.server?.name ?? '')
const url = ref(props.server?.url ?? '')
const transport = ref<McpTransport>(props.server?.transport ?? 'http')
const headers = ref<McpHeaderInput[]>(props.server?.headers.map(header => ({ name: header.name, value: header.value, secret: header.secret })) ?? [])
const headersError = ref<string | null>(null)
const saving = ref(false)
const authorizing = ref(false)
const current = ref<McpServerView | null>(props.server)

const isNew = computed(() => current.value === null)
const canSave = computed(() => !saving.value && name.value.trim() !== '' && url.value.trim() !== '' && headersError.value === null)

async function save() {
  saving.value = true
  try {
    const body = { name: name.value.trim(), url: url.value.trim(), transport: transport.value, headers: headers.value }
    const { server } = current.value === null ? await api.createMcpServer(body) : await api.updateMcpServer(current.value.key, body)
    current.value = server
    emit('saved', server)
    if (server.status === 'ok') toast.success('已保存，连接成功')
    else if (server.status === 'needs_auth') toast.warning('已保存，这个服务需要授权')
    else toast.error(`已保存，但连接失败：${server.last_error ?? '未知错误'}`)
  } catch (cause) {
    toast.error(cause instanceof Error ? cause.message : String(cause))
  } finally {
    saving.value = false
  }
}

async function setEnabled(enabled: boolean) {
  if (!current.value) return
  try {
    const { server } = await api.updateMcpServer(current.value.key, { enabled })
    current.value = server
    emit('saved', server)
  } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)) }
}

async function remove() {
  if (!current.value) return
  try {
    await api.deleteMcpServer(current.value.key)
    toast.success('已删除')
    emit('deleted')
  } catch (cause) { toast.error(cause instanceof Error ? cause.message : String(cause)) }
}

// The callback page posts here from its own window once the tokens are stored.
let channel: BroadcastChannel | null = null
function listenForCallback() {
  channel?.close()
  channel = new BroadcastChannel(OAUTH_CHANNEL)
  channel.onmessage = async (event: MessageEvent<{ ok: boolean, key: string | null }>) => {
    if (!current.value || event.data.key !== current.value.key) return
    channel?.close()
    channel = null
    authorizing.value = false
    await reload()
    if (event.data.ok) toast.success('授权完成')
    else toast.error('授权没有完成，详情见授权窗口')
  }
}
onBeforeUnmount(() => channel?.close())

async function reload() {
  if (!current.value) return
  const { servers } = await api.mcpServers()
  const fresh = servers.find(server => server.key === current.value?.key)
  if (fresh) {
    current.value = fresh
    emit('saved', fresh)
  }
}

async function authorize() {
  if (!current.value) return
  // Opened inside the click, before any await: a window opened later counts as a popup and is blocked.
  const popup = window.open('', '_blank', 'popup,width=560,height=720')
  authorizing.value = true
  try {
    const result = await api.authorizeMcpServer(current.value.key)
    if (result.authorization_url) {
      if (popup) popup.location.href = result.authorization_url
      else window.location.assign(result.authorization_url)
      listenForCallback()
      return
    }
    popup?.close()
    authorizing.value = false
    if (result.server) {
      current.value = result.server
      emit('saved', result.server)
    }
    toast.success('已授权')
  } catch (cause) {
    popup?.close()
    authorizing.value = false
    toast.error(cause instanceof Error ? cause.message : String(cause))
  }
}

const needsAuth = computed(() => current.value?.status === 'needs_auth')
</script>

<template lang="pug">
.flex.flex-col.gap-4
  .flex.flex-wrap.items-center.gap-2
    Button(variant="ghost" class="min-h-10 md:min-h-8" @click="emit('back')") ← 全部服务
    template(v-if="current")
      h2.min-w-0.truncate.text-lg.font-semibold {{ current.name }}
      Badge(:variant="statusVariant(current.status)") {{ STATUS_LABELS[current.status] }}
      Switch(:model-value="current.enabled" aria-label="启用这个服务" class="ml-auto" @update:model-value="setEnabled")
    h2.text-lg.font-semibold(v-else) 添加 MCP 服务

  Alert(v-if="current && current.status === 'error' && current.last_error" variant="destructive")
    TriangleAlertIcon
    AlertTitle 连接失败
    AlertDescription {{ current.last_error }}
  Alert(v-if="needsAuth")
    KeyRoundIcon
    AlertTitle 服务要求认证
    AlertDescription
      p 如果它支持 OAuth（例如 Notion），点「授权」在新窗口登录；如果它用 API Key，请检查请求头是否正确。
      Button(class="mt-2 min-h-10 md:min-h-8" :disabled="authorizing" @click="authorize") {{ authorizing ? '等待授权完成…' : '授权' }}

  Tabs(v-if="current" v-model="tab")
    TabsList
      TabsTrigger(value="general" class="min-h-10 md:min-h-7") 通用
      TabsTrigger(value="tools" class="min-h-10 md:min-h-7") 工具

  ToolsPanel(v-if="current && tab === 'tools'" :key="current.key" :server="current" @updated="current = $event; emit('saved', $event)")

  form.flex.flex-col.gap-4(v-else @submit.prevent="save")
    FieldGroup
      Field
        FieldLabel(for="mcp-name") 名称
        Input#mcp-name(v-model="name" maxlength="80" placeholder="例如 Notion" class="min-h-10")
      Field
        FieldLabel(for="mcp-url") 服务地址
        Input#mcp-url(v-model="url" type="url" placeholder="https://…/mcp" class="min-h-10 font-mono text-sm")
        FieldDescription 只支持远程服务。密钥请放在请求头里，不要写进地址。
      Field
        FieldLabel(for="mcp-transport") 传输方式
        NativeSelect#mcp-transport(v-model="transport" class="w-full")
          NativeSelectOption(v-for="(label, value) in TRANSPORT_LABELS" :key="value" :value="value") {{ label }}
        FieldDescription 不确定就选 Streamable HTTP；只有较旧的服务才用 SSE。
      Field
        FieldLabel 请求头
        HeadersEditor(v-model="headers" v-model:error="headersError" :initial="server?.headers ?? []" :oauth="current?.oauth ?? false")
        FieldDescription 名字里带 auth、token、key 之类的请求头默认加密保存，保存后不再显示；点锁图标可以切换。
    .flex.flex-wrap.items-center.gap-2
      Button(type="submit" class="min-h-10" :disabled="!canSave") {{ saving ? '正在保存并连接…' : isNew ? '添加并连接' : '保存并重新连接' }}
      Button(v-if="current && current.oauth && !needsAuth" type="button" variant="outline" class="min-h-10" :disabled="authorizing" @click="authorize") 重新授权
      AlertDialog(v-if="current")
        AlertDialogTrigger(as-child)
          Button(type="button" variant="ghost" class="ml-auto min-h-10 text-destructive")
            Trash2Icon(data-icon="inline-start")
            | 删除
        AlertDialogContent
          AlertDialogHeader
            AlertDialogTitle 删除 {{ current.name }}？
            AlertDialogDescription 请求头和授权信息会一起删除，模型也无法再调用它。历史对话里的调用记录不受影响。
          AlertDialogFooter
            AlertDialogCancel 取消
            AlertDialogAction(@click="remove") 删除
</template>
