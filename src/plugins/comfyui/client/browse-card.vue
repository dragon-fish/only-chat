<script setup lang="ts">
import { computed } from 'vue'
import MarkdownRender from 'markstream-vue'
import { BookOpenIcon, BoxesIcon, FileJsonIcon, ListIcon, PuzzleIcon, TriangleAlertIcon } from '@lucide/vue'
import { Alert, AlertDescription, AlertTitle } from '@/client/ui/alert'
import { Badge } from '@/client/ui/badge'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/client/ui/collapsible'
import { Spinner } from '@/client/ui/spinner'
import type { ToolCallPart, ToolResultPart } from '@/shared/parts'
import { COMFYUI_LIST_MODELS_TOOL_ID, COMFYUI_LIST_WORKFLOWS_TOOL_ID, COMFYUI_READ_TOOL_ID } from '@/shared/plugins'
import { ComfyuiToolErrorSchema } from '../shared'
import { describeTemplate, inputsOf, workflowNodes, type NodeInfo, type TemplateRow } from './browse'

/** Serves the four read-only tools; which one it is comes from the call's name. */
const props = defineProps<{ call: ToolCallPart, result: ToolResultPart | null }>()

const args = computed(() => (typeof props.call.args === 'object' && props.call.args !== null ? props.call.args : {}) as Record<string, unknown>)
const content = computed(() => (typeof props.result?.content === 'object' && props.result.content !== null ? props.result.content : null) as Record<string, unknown> | null)
const failure = computed(() => ComfyuiToolErrorSchema.safeParse(props.result?.content).data ?? null)

const templates = computed(() => (Array.isArray(content.value?.templates) ? content.value.templates as TemplateRow[] : null))
const guides = computed(() => (Array.isArray(content.value?.guides) ? content.value.guides as string[] : []))
const guideText = computed(() => (typeof content.value?.content === 'string' ? content.value.content : null))
const workflow = computed(() => (content.value?.workflow && typeof content.value.workflow === 'object' ? workflowNodes(content.value.workflow) : null))
const folders = computed(() => (Array.isArray(content.value?.folders) ? content.value.folders as string[] : null))
const files = computed(() => (Array.isArray(content.value?.files) ? content.value.files as string[] : null))
const nodes = computed(() => (Array.isArray(content.value?.nodes) ? content.value.nodes as NodeInfo[] : null))
const matches = computed(() => (Array.isArray(content.value?.matches) ? content.value.matches as Array<{ name: string, display_name?: string | null, category?: string }> : null))
const note = computed(() => (typeof content.value?.note === 'string' ? content.value.note : null))

const classTypes = computed(() => (Array.isArray(args.value.class_types) ? args.value.class_types as string[] : []))
const search = computed(() => (typeof args.value.search === 'string' ? args.value.search : null))

const view = computed(() => {
  switch (props.call.name) {
    case COMFYUI_LIST_WORKFLOWS_TOOL_ID:
      return {
        icon: ListIcon, title: '查看 ComfyUI 模板',
        badge: templates.value ? `${templates.value.length} 个模板 · ${guides.value.length} 份指南` : '',
      }
    case COMFYUI_READ_TOOL_ID: {
      const path = typeof args.value.path === 'string' ? args.value.path : ''
      return {
        icon: guideText.value !== null ? BookOpenIcon : FileJsonIcon, title: `读取 ${path}`,
        badge: workflow.value ? `${workflow.value.length} 个节点` : guideText.value !== null ? '指南' : '',
      }
    }
    case COMFYUI_LIST_MODELS_TOOL_ID: {
      const folder = typeof args.value.folder === 'string' ? args.value.folder : null
      return {
        icon: BoxesIcon, title: folder ? `查看模型 ${folder}` : '查看模型目录',
        badge: files.value ? `${files.value.length} 个文件` : folders.value ? `${folders.value.length} 个目录` : '',
      }
    }
    // comfyui_node_info
    default: {
      const parts = [
        classTypes.value.length ? `查询节点 ${classTypes.value.join('、')}` : null,
        search.value ? `搜索节点“${search.value}”` : null,
      ].filter(Boolean)
      const count = (nodes.value?.length ?? 0) + (matches.value?.length ?? 0)
      return { icon: PuzzleIcon, title: parts.join('，') || '查询节点', badge: content.value && !failure.value ? `${count} 个` : '' }
    }
  }
})
const readable = computed(() => templates.value || guideText.value !== null || workflow.value || folders.value || files.value || nodes.value || matches.value)
</script>

<template lang="pug">
.flex.w-full.flex-col.gap-2
  .oc-turn-row.text-sm.text-muted-foreground(v-if="!result")
    Spinner(class="size-4 shrink-0")
    span.min-w-0.truncate 正在{{ view.title }}
  Alert(v-else-if="failure" variant="destructive")
    TriangleAlertIcon
    AlertTitle {{ view.title }}失败
    AlertDescription {{ failure.error }}
  Collapsible(v-else-if="readable")
    CollapsibleTrigger(class="oc-turn-row text-sm hover:bg-accent")
      component(:is="view.icon" class="size-4 shrink-0 text-muted-foreground")
      span.min-w-0.truncate.text-left {{ view.title }}
      Badge(v-if="view.badge" variant="secondary" class="ml-auto shrink-0") {{ view.badge }}
    CollapsibleContent
      .oc-scroll.flex.flex-col.gap-3.overflow-auto.px-2.py-2.text-sm(class="max-h-96")
        //- Templates and guides
        template(v-if="templates")
          p.text-muted-foreground(v-if="!templates.length && !guides.length") {{ note ?? '没有模板或指南。' }}
          ul.flex.flex-col.gap-2(v-if="templates.length")
            li.flex.flex-col.gap-1(v-for="template in templates" :key="template.name")
              .flex.min-w-0.items-center.gap-2
                span.font-medium {{ template.name }}
                Badge(v-if="!template.usable_as_template" variant="outline" class="shrink-0") 仅原始模式
              span.truncate.text-xs.text-muted-foreground(v-if="template.model" :title="template.model") {{ template.model }}
              span.text-xs.text-muted-foreground(v-if="describeTemplate(template)") {{ describeTemplate(template) }}
              span.text-xs.text-destructive(v-if="template.problem") {{ template.problem }}
              .flex.flex-wrap.gap-1(v-if="template.suggested_loras?.length")
                Badge(v-for="lora in template.suggested_loras" :key="lora.name" variant="outline" class="font-mono text-xs font-normal") {{ lora.name }}
          .flex.flex-col.gap-1(v-if="guides.length")
            span.text-xs.text-muted-foreground 指南
            ul.flex.flex-col(class="gap-0.5")
              li.flex.items-center.gap-1.font-mono.text-xs(v-for="guide in guides" :key="guide")
                BookOpenIcon(class="size-3 shrink-0 text-muted-foreground")
                | {{ guide }}
        //- A guide reads as the markdown it is
        MarkdownRender(v-else-if="guideText !== null" mode="chat" :content="guideText" :final="true")
        //- A workflow reads as its nodes
        ul.flex.flex-col.font-mono.text-xs(v-else-if="workflow" class="gap-0.5")
          li.flex.gap-2(v-for="node in workflow" :key="node.id")
            span.shrink-0.text-muted-foreground {{ '#' }}{{ node.id }}
            span {{ node.classType }}
            span.min-w-0.truncate.text-muted-foreground(v-if="node.title") {{ node.title }}
        //- Model folders and files
        ul.flex.flex-wrap.gap-1(v-else-if="folders")
          li(v-for="folder in folders" :key="folder")
            Badge(variant="outline" class="font-mono text-xs font-normal") {{ folder }}
        ul.flex.flex-col.font-mono.text-xs(v-else-if="files" class="gap-0.5")
          li.text-muted-foreground(v-if="!files.length") 这个目录是空的。
          li.break-all(v-for="file in files" :key="file") {{ file }}
        //- Node definitions and search matches
        template(v-else)
          .flex.flex-col.gap-1(v-for="node in nodes ?? []" :key="node.class_type")
            .flex.min-w-0.items-baseline.gap-2
              span.font-mono.font-medium {{ node.class_type }}
              span.min-w-0.truncate.text-xs.text-muted-foreground(v-if="node.display_name && node.display_name !== node.class_type") {{ node.display_name }}
            span.text-xs.text-destructive(v-if="node.error") {{ node.error }}
            ul.flex.flex-col.font-mono.text-xs(v-else class="gap-0.5")
              li(v-for="input in inputsOf(node)" :key="input.name")
                span {{ input.name }}
                span.text-muted-foreground : {{ input.type }}{{ input.optional ? '（可选）' : '' }}
              li.text-muted-foreground(v-if="node.output?.length") → {{ node.output.join(', ') }}
          ul.flex.flex-col(v-if="matches?.length" class="gap-0.5")
            li.flex.min-w-0.items-baseline.gap-2(v-for="match in matches" :key="match.name")
              span.font-mono.text-xs {{ match.name }}
              span.min-w-0.truncate.text-xs.text-muted-foreground {{ [match.display_name, match.category].filter(Boolean).join(' · ') }}
          p.text-xs.text-muted-foreground(v-else-if="matches && !nodes?.length") 没有匹配的节点。
        //- Only truncation is worth a person's attention; the other notes explain conventions to the model.
        p.text-xs.text-muted-foreground(v-if="note && (files || matches)") {{ note }}
  pre.oc-scroll.max-h-64.overflow-auto.rounded-md.bg-muted.p-3.text-xs(v-else)
    | {{ JSON.stringify(result?.content, null, 2) }}
</template>
