<script setup lang="ts">
import SecretRowsEditor from '@/client/components/secret-rows-editor.vue'
import { mcpHeadersProblem, type McpHeaderInput, type McpHeaderView } from '@/shared/mcp'

const props = defineProps<{ initial: readonly McpHeaderView[], oauth: boolean }>()
const headers = defineModel<McpHeaderInput[]>({ required: true })
const error = defineModel<string | null>('error', { default: null })

const validate = (rows: readonly { name: string }[]) => mcpHeadersProblem(rows, { oauth: props.oauth })
</script>

<template lang="pug">
SecretRowsEditor(v-model="headers" v-model:error="error" :initial="initial" noun="请求头" :validate="validate")
</template>
