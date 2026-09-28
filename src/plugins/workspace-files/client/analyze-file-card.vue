<script setup lang="ts">
import { computed } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
const props = defineProps<{ call: ToolCallPart; result: ToolResultPart | null }>()
const input = computed(() => props.call.args as { path?: string; question?: string })
const output = computed(() => props.result?.content as { text?: string; error?: string; message?: string; truncated?: boolean } | undefined)
</script>
<template>
  <div class="flex flex-col gap-2 text-sm">
    <div v-if="!result" class="flex items-center gap-2 text-muted-foreground"><Spinner />正在分析 {{ input.path }}</div>
    <Alert v-else-if="output?.error" variant="destructive"><AlertTitle>文件分析未完成</AlertTitle><AlertDescription>{{ output.message }}</AlertDescription></Alert>
    <Collapsible v-else>
      <CollapsibleTrigger class="text-left underline">文件分析 · {{ input.path }}</CollapsibleTrigger>
      <CollapsibleContent class="flex flex-col gap-2 py-2">
        <p v-if="input.question" class="text-muted-foreground">{{ input.question }}</p>
        <p v-if="output?.truncated" class="text-muted-foreground">输出达到模型长度限制，以下内容不完整。</p>
        <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans">{{ output?.text }}</pre>
      </CollapsibleContent>
    </Collapsible>
  </div>
</template>
