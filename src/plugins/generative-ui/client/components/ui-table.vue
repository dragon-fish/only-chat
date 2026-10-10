<script setup lang="ts">
import { computed } from 'vue'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/client/ui/table'
import { isElement, RenderValue, type NodeProps } from '../runtime'

const { props, renderNode } = defineProps<NodeProps<{ columns?: unknown[], rows?: unknown[] }>>()
const columns = computed(() => (props.columns ?? []).map(column => String(column ?? '')))
const rows = computed(() => (props.rows ?? []).filter(Array.isArray) as unknown[][])
</script>

<template lang="pug">
//- The table scrolls inside its own box; the chat column never does.
.min-w-0.rounded-lg.border
  Table
    TableHeader
      TableRow
        TableHead.whitespace-nowrap(v-for="(column, index) in columns" :key="index") {{ column }}
    TableBody
      TableRow(v-for="(row, rowIndex) in rows" :key="rowIndex")
        TableCell.align-top(v-for="(_, index) in columns" :key="index" class="min-w-20 whitespace-normal")
          RenderValue(v-if="isElement(row[index])" :value="row[index]" :render="renderNode")
          span(v-else) {{ row[index] ?? '' }}
</template>
