<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/client/lib/api'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/client/ui/card'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Spinner } from '@/client/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/client/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'
import type { AuditProvider } from '@/shared/api'
import type { Conversation } from '@/shared/models'

const props = defineProps<{ userId: number }>()
const providers = shallowRef<AuditProvider[]>([])
const conversations = shallowRef<Conversation[]>([])
const kind = ref<'chat' | 'image'>('chat')
const loadingProviders = ref(false)
const loadingConversations = ref(false)
const error = ref('')

async function loadProviders() {
  loadingProviders.value = true
  try { providers.value = await api.auditProviders(props.userId) }
  catch { error.value = '无法加载该用户的数据。审计可能未开启，或该用户不存在。' }
  finally { loadingProviders.value = false }
}
async function loadConversations() {
  loadingConversations.value = true
  try { conversations.value = await api.auditConversations(props.userId, kind.value) }
  catch { error.value = '无法加载该用户的数据。审计可能未开启，或该用户不存在。' }
  finally { loadingConversations.value = false }
}
function selectKind(value: unknown) {
  if (value === 'chat' || value === 'image') kind.value = value
}
watch(() => props.userId, () => { error.value = ''; void loadProviders() }, { immediate: true })
watch([() => props.userId, kind], () => { void loadConversations() }, { immediate: true })
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 审计 · 用户 {{ userId }}
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-5xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 审计 · 用户 {{ userId }}
        p.text-sm.text-muted-foreground 只读查看该用户的供应商配置与会话，不显示任何密钥。
      Alert(v-if="error" variant="destructive")
        AlertTitle 加载失败
        AlertDescription {{ error }}
      Tabs(default-value="providers")
        TabsList
          TabsTrigger(value="providers") 供应商
          TabsTrigger(value="conversations") 会话
        TabsContent(value="providers" class="flex flex-col gap-4 pt-2")
          .flex.justify-center.py-8(v-if="loadingProviders")
            Spinner(aria-label="正在加载供应商")
          template(v-else-if="providers.length")
            Card(v-for="provider in providers" :key="provider.id" :data-audit-provider="provider.id")
              CardHeader
                CardTitle.flex.flex-wrap.items-center.gap-2
                  span {{ provider.name }}
                  Badge(:variant="provider.enabled ? 'secondary' : 'outline'") {{ provider.enabled ? '已启用' : '已停用' }}
                  Badge(:variant="provider.has_key ? 'secondary' : 'destructive'") {{ provider.has_key ? '已配置密钥' : '未配置密钥' }}
              CardContent.flex.flex-col.gap-4
                .flex.flex-col.gap-1
                  p.text-sm.font-medium 接口
                  p.text-sm.text-muted-foreground(v-if="!provider.interfaces.length") 无
                  .flex.flex-wrap.items-center.gap-2.text-sm(v-for="endpoint in provider.interfaces" :key="endpoint.id")
                    Badge(variant="outline") {{ endpoint.protocol }}
                    code.break-all {{ endpoint.base_url }}
                    Badge(v-if="endpoint.id === provider.default_interface_id" variant="secondary") 默认
                .flex.flex-col.gap-1
                  p.text-sm.font-medium 已启用模型（{{ provider.models.length }}）
                  p.text-sm.text-muted-foreground(v-if="!provider.models.length") 无
                  .flex.flex-wrap.gap-1
                    Badge(v-for="model in provider.models" :key="model.id" variant="outline" :title="model.model_id")
                      | {{ model.name ?? model.model_id }}
          Empty(v-else-if="!error")
            EmptyHeader
              EmptyTitle 没有供应商
              EmptyDescription 该用户尚未添加任何供应商。
        TabsContent(value="conversations" class="flex flex-col gap-4 pt-2")
          ToggleGroup(type="single" variant="outline" :model-value="kind" aria-label="会话类型" @update:model-value="selectKind")
            ToggleGroupItem(value="chat") 聊天
            ToggleGroupItem(value="image") 图片
          .flex.justify-center.py-8(v-if="loadingConversations")
            Spinner(aria-label="正在加载会话")
          Card(v-else-if="conversations.length")
            CardHeader
              CardTitle 会话
              CardDescription 共 {{ conversations.length }} 个，按最近更新排序。
            CardContent.flex.flex-col
              RouterLink(
                v-for="conversation in conversations" :key="conversation.id"
                :to="`/admin/audit/${userId}/c/${conversation.id}`" :data-audit-conversation="conversation.id"
                class="flex items-center justify-between gap-4 rounded-md px-2 py-2 text-sm hover:bg-muted")
                span.truncate {{ conversation.title || '未命名会话' }}
                span.shrink-0.text-xs.text-muted-foreground {{ new Date(conversation.updated_at).toLocaleString('zh-CN') }}
          Empty(v-else-if="!error")
            EmptyHeader
              EmptyTitle 没有会话
              EmptyDescription 该用户还没有这一类会话。
</template>
