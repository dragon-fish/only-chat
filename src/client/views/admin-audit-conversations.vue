<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AuditConversationPreview from '@/client/components/audit-conversation-preview.vue'
import AuditPager from '@/client/components/audit-pager.vue'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { useAuditListing, useAuditUsers } from '@/client/composables/use-audit-listing'
import { api } from '@/client/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Field, FieldLabel } from '@/client/ui/field'
import { Input } from '@/client/ui/input'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Spinner } from '@/client/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import type { AuditConversationRow, AuditPage } from '@/shared/api'

const { query, withQuery, update } = useAuditListing()
const users = useAuditUsers()
const page = shallowRef<AuditPage<AuditConversationRow> | null>(null)
const loading = ref(false)
const error = ref('')

/** The URL holds local calendar days; the API takes epoch ms, `until` exclusive. */
function localDay(day: string | undefined, offsetDays = 0): string | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const start = new Date(`${day}T00:00:00`)
  start.setDate(start.getDate() + offsetDays)
  return Number.isNaN(start.getTime()) ? undefined : String(start.getTime())
}
function apiQuery(current: Record<string, string>): Record<string, string> {
  const { since, until, preview: _preview, ...rest } = current
  const bounds = { since: localDay(since), until: localDay(until, 1) }
  return { ...rest, ...Object.fromEntries(Object.entries(bounds).filter((entry): entry is [string, string] => entry[1] !== undefined)) }
}

/**
 * The open preview is `?preview=<id>`, so the browser's back button closes it and the link can be
 * shared. It is not a filter: opening or closing it must not reload the listing.
 */
const router = useRouter()
const previewId = computed(() => /^\d+$/.test(query.value.preview ?? '') ? Number(query.value.preview) : null)
let previewPushed = false
function markPreviewPushed() { previewPushed = true }
function closePreview() {
  if (previewPushed) router.back()
  else void router.replace({ query: withQuery({ preview: undefined }, true) })
  previewPushed = false
}

let token = 0
const listingKey = computed(() => JSON.stringify(apiQuery(query.value)))
watch(listingKey, async () => {
  const mine = ++token
  loading.value = true
  error.value = ''
  try {
    const loaded = await api.auditConversations(apiQuery(query.value))
    if (mine === token) page.value = loaded
  } catch {
    if (mine === token) { page.value = null; error.value = '无法加载会话列表。审计可能未开启，或过滤条件无效。' }
  } finally { if (mine === token) loading.value = false }
}, { immediate: true })

const formatTime = (at: number) => new Date(at).toLocaleString('zh-CN')
const formatTokens = (count: number) => count.toLocaleString('zh-CN')
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 全站会话
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-6xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 全站会话
        p.text-sm.text-muted-foreground 只读列出所有用户的会话。点击标题预览会话内容。
      form.flex.flex-wrap.items-end.gap-4(data-audit-filters @submit.prevent)
        Field(class="w-56")
          FieldLabel(for="audit-user") 用户
          NativeSelect#audit-user(:model-value="query.user ?? ''" class="w-full" @update:model-value="update({ user: String($event ?? '') })")
            NativeSelectOption(value="") 全部用户
            NativeSelectOption(v-for="user in users" :key="user.id" :value="user.id") {{ user.name }}（{{ user.email }}）
        Field(class="w-40")
          FieldLabel(for="audit-since") 活跃于（起）
          Input#audit-since(type="date" :model-value="query.since ?? ''" @update:model-value="update({ since: String($event) })")
        Field(class="w-40")
          FieldLabel(for="audit-until") 活跃于（止）
          Input#audit-until(type="date" :model-value="query.until ?? ''" @update:model-value="update({ until: String($event) })")
        Field(class="w-36")
          FieldLabel(for="audit-sort") 排序
          NativeSelect#audit-sort(:model-value="query.sort ?? 'id'" class="w-full" @update:model-value="update({ sort: String($event) })")
            NativeSelectOption(value="id") ID
            NativeSelectOption(value="created") 创建时间
            NativeSelectOption(value="active") 最近活跃
        Field(class="w-28")
          FieldLabel(for="audit-dir") 顺序
          NativeSelect#audit-dir(:model-value="query.dir ?? 'desc'" class="w-full" @update:model-value="update({ dir: String($event) })")
            NativeSelectOption(value="desc") 降序
            NativeSelectOption(value="asc") 升序
      Alert(v-if="error" variant="destructive")
        AlertTitle 加载失败
        AlertDescription {{ error }}
      AuditPager(v-if="page?.rows.length" :prev="page.prev" :next="page.next")
      .flex.justify-center.py-8(v-if="loading && !page")
        Spinner(aria-label="正在加载会话")
      Table(v-else-if="page?.rows.length" :aria-busy="loading")
        TableHeader
          TableRow
            TableHead 标题
            TableHead 所有者
            TableHead 类型
            TableHead 模型
            TableHead 创建时间
            TableHead 最近活跃
            TableHead.text-right token（输入 / 输出）
        TableBody
          TableRow(v-for="row in page.rows" :key="row.id" :data-audit-conversation="row.id")
            TableCell(class="max-w-72")
              .flex.items-center.gap-2
                RouterLink.truncate.font-medium(
                  :to="{ query: withQuery({ preview: String(row.id) }, true) }" class="hover:underline"
                  @click="markPreviewPushed") {{ row.title || '未命名会话' }}
                Badge(v-if="row.archived" variant="outline") 已归档
            TableCell
              RouterLink(:to="{ query: withQuery({ user: String(row.owner.id) }) }" :title="row.owner.email" class="hover:underline") {{ row.owner.name }}
            TableCell {{ row.kind === 'image' ? '图片' : '聊天' }}
            TableCell(class="max-w-48")
              span.block.truncate(v-if="row.model" :title="row.model.model_id") {{ row.model.name ?? row.model.model_id }}
              span.text-muted-foreground(v-else) —
            TableCell.whitespace-nowrap {{ formatTime(row.created_at) }}
            TableCell.whitespace-nowrap {{ formatTime(row.updated_at) }}
            TableCell.whitespace-nowrap.text-right.tabular-nums {{ formatTokens(row.tokens.input) }} / {{ formatTokens(row.tokens.output) }}
      Empty(v-else-if="!error")
        EmptyHeader
          EmptyTitle 没有会话
          EmptyDescription 没有符合过滤条件的会话。
      AuditPager(v-if="page?.rows.length" :prev="page.prev" :next="page.next")
  AuditConversationPreview(
    v-if="previewId !== null" :key="previewId" :conversation-id="previewId" @leave="closePreview")
</template>
