<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import AuditPager from '@/client/components/audit-pager.vue'
import ResponsiveOverlay from '@/client/components/layout/responsive-overlay.vue'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { useAuditListing, useAuditUsers } from '@/client/composables/use-audit-listing'
import { api } from '@/client/lib/api'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/client/ui/empty'
import { Field, FieldLabel } from '@/client/ui/field'
import { NativeSelect, NativeSelectOption } from '@/client/ui/native-select'
import { Spinner } from '@/client/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import type { AuditPage, AuditProviderRow } from '@/shared/api'

const { query, withQuery, update } = useAuditListing()
const users = useAuditUsers()
const page = shallowRef<AuditPage<AuditProviderRow> | null>(null)
const loading = ref(false)
const error = ref('')

const selected = shallowRef<AuditProviderRow | null>(null)
const modelName = (model: AuditProviderRow['models'][number]) => model.name ?? model.model_id
/** The first few names say what kind of provider it is; the full list is in the details. */
function modelSummary(row: AuditProviderRow): string {
  const names = row.models.slice(0, 3).map(modelName).join('、')
  return row.models.length > 3 ? `${names} 等共计 ${row.models.length} 个` : names
}

let token = 0
watch(query, async current => {
  const mine = ++token
  loading.value = true
  error.value = ''
  try {
    const loaded = await api.auditProviders(current)
    if (mine === token) page.value = loaded
  } catch {
    if (mine === token) { page.value = null; error.value = '无法加载供应商列表。审计可能未开启，或过滤条件无效。' }
  } finally { if (mine === token) loading.value = false }
}, { immediate: true })
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 全站供应商
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-6xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 全站供应商
        p.text-sm.text-muted-foreground 只读列出所有用户的供应商配置，不显示任何密钥。
      form.flex.flex-wrap.items-end.gap-4(data-audit-filters @submit.prevent)
        Field(class="w-56")
          FieldLabel(for="audit-user") 用户
          NativeSelect#audit-user(:model-value="query.user ?? ''" class="w-full" @update:model-value="update({ user: String($event ?? '') })")
            NativeSelectOption(value="") 全部用户
            NativeSelectOption(v-for="user in users" :key="user.id" :value="user.id") {{ user.name }}（{{ user.email }}）
        Field(class="w-28")
          FieldLabel(for="audit-dir") 顺序
          NativeSelect#audit-dir(:model-value="query.dir ?? 'desc'" class="w-full" @update:model-value="update({ dir: String($event) })")
            NativeSelectOption(value="desc") 最新在前
            NativeSelectOption(value="asc") 最早在前
      Alert(v-if="error" variant="destructive")
        AlertTitle 加载失败
        AlertDescription {{ error }}
      AuditPager(v-if="page?.rows.length" :prev="page.prev" :next="page.next")
      .flex.justify-center.py-8(v-if="loading && !page")
        Spinner(aria-label="正在加载供应商")
      Table(v-else-if="page?.rows.length" :aria-busy="loading")
        TableHeader
          TableRow
            TableHead ID
            TableHead 名称
            TableHead 所有者
            TableHead 状态
            TableHead 默认接口
            TableHead 已启用模型
        TableBody
          TableRow(v-for="row in page.rows" :key="row.id" :data-audit-provider="row.id")
            TableCell.tabular-nums.text-muted-foreground {{ row.id }}
            TableCell
              button.font-medium(type="button" class="text-left hover:underline" @click="selected = row") {{ row.name }}
            TableCell
              RouterLink(:to="{ query: withQuery({ user: String(row.owner.id) }) }" :title="row.owner.email" class="hover:underline") {{ row.owner.name }}
            TableCell
              .flex.flex-wrap.gap-1
                Badge(:variant="row.enabled ? 'secondary' : 'outline'") {{ row.enabled ? '已启用' : '已停用' }}
                Badge(:variant="row.has_key ? 'secondary' : 'destructive'") {{ row.has_key ? '已配置密钥' : '未配置密钥' }}
            TableCell(class="max-w-72")
              template(v-for="endpoint in row.interfaces" :key="endpoint.id")
                code.block.truncate.text-xs(v-if="endpoint.id === row.default_interface_id" :title="endpoint.base_url") {{ endpoint.base_url }}
              span.text-muted-foreground(v-if="!row.interfaces.some(endpoint => endpoint.id === row.default_interface_id)") —
            TableCell(class="max-w-80")
              span.block.truncate(v-if="row.models.length" :title="row.models.map(modelName).join('\n')") {{ modelSummary(row) }}
              span.text-muted-foreground(v-else) —
      Empty(v-else-if="!error")
        EmptyHeader
          EmptyTitle 没有供应商
          EmptyDescription 没有符合过滤条件的供应商。
      AuditPager(v-if="page?.rows.length" :prev="page.prev" :next="page.next")
  ResponsiveOverlay(
    mode="dialog" :open="selected !== null" :title="selected ? `${selected.name}（#${selected.id}）` : ''"
    @update:open="open => { if (!open) selected = null }")
    dl.grid.gap-x-4.gap-y-3.text-sm(v-if="selected" class="grid-cols-[auto_1fr]")
      dt.text-muted-foreground ID
      dd.tabular-nums {{ selected.id }}
      dt.text-muted-foreground 所有者
      dd {{ selected.owner.name }}（{{ selected.owner.email }}）
      dt.text-muted-foreground 状态
      dd.flex.flex-wrap.gap-1
        Badge(:variant="selected.enabled ? 'secondary' : 'outline'") {{ selected.enabled ? '已启用' : '已停用' }}
        Badge(:variant="selected.has_key ? 'secondary' : 'destructive'") {{ selected.has_key ? '已配置密钥' : '未配置密钥' }}
      dt.text-muted-foreground 创建时间
      dd {{ new Date(selected.created_at).toLocaleString('zh-CN') }}
      dt.text-muted-foreground 接口
      dd.flex.flex-col.gap-1
        span.text-muted-foreground(v-if="!selected.interfaces.length") —
        .flex.flex-wrap.items-center.gap-1(v-for="endpoint in selected.interfaces" :key="endpoint.id")
          Badge(variant="outline") {{ endpoint.protocol }}
          code.break-all.text-xs {{ endpoint.base_url }}
          Badge(v-if="endpoint.id === selected.default_interface_id" variant="secondary") 默认
      dt.text-muted-foreground 已启用模型
      dd
        span.text-muted-foreground(v-if="!selected.models.length") —
        template(v-else)
          p.mb-2.text-muted-foreground 共 {{ selected.models.length }} 个
          ul.flex.flex-col.gap-1
            li.flex.flex-wrap.items-baseline.gap-2(v-for="model in selected.models" :key="model.id")
              span {{ modelName(model) }}
              code.text-xs.text-muted-foreground(v-if="model.name") {{ model.model_id }}
</template>
