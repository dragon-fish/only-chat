<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { AUDIT_LIMITS, useAuditListing } from '@/client/composables/use-audit-listing'
import { Button } from '@/client/ui/button'

defineProps<{ prev: string | null, next: string | null }>()
const { query, withQuery } = useAuditListing()
</script>

<template lang="pug">
.flex.flex-wrap.items-center.justify-between.gap-3.text-sm
  .flex.flex-wrap.items-center.gap-1.text-muted-foreground
    span 每页
    template(v-for="(limit, index) in AUDIT_LIMITS" :key="limit")
      span(v-if="index > 0") |
      span.font-medium.text-foreground(v-if="(query.limit ?? '50') === limit") {{ limit }}
      RouterLink.underline-offset-4(v-else :to="{ query: withQuery({ limit }) }" class="hover:underline") {{ limit }}
  .flex.gap-2
    Button(v-if="prev" variant="outline" size="sm" as-child)
      RouterLink(data-audit-prev :to="{ query: withQuery({ before: prev }) }") 上一页
    Button(v-else variant="outline" size="sm" disabled) 上一页
    Button(v-if="next" variant="outline" size="sm" as-child)
      RouterLink(data-audit-next :to="{ query: withQuery({ after: next }) }") 下一页
    Button(v-else variant="outline" size="sm" disabled) 下一页
</template>
