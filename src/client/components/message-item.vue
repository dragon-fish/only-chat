<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownRender from 'markstream-vue'
import { Pencil, RefreshCw } from '@lucide/vue'
import { api } from '@/client/lib/api'
import { Button } from '@/client/ui/button'
import { Textarea } from '@/client/ui/textarea'
import BranchSwitcher from '@/client/components/branch-switcher.vue'
import { useSyncStore } from '@/client/stores/sync'
import type { Message } from '@/shared/models'

const props = defineProps<{ message: Message }>()
const sync = useSyncStore()
const streaming = computed(() => props.message.status === 'streaming')
const editing = ref(false)
const draft = ref('')

const textParts = computed(() => props.message.parts.filter((p) => p.type === 'text'))
const reasoning = computed(() => props.message.parts.filter((p) => p.type === 'reasoning').map((p) => p.text).join('\n'))
const images = computed(() => props.message.parts.filter((p) => p.type === 'image'))
const markdown = computed(() => textParts.value.map((p) => p.text).join(''))

// Hover is unavailable on touch, and a failed/stopped message must expose 重试 without one, so the
// row only fades on `md` and up, and never on a terminal-failure message.
const terminal = computed(() => props.message.status === 'error' || props.message.status === 'aborted')
const actionsClass = computed(() => terminal.value
  ? 'opacity-100'
  : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100')

function startEdit() {
  draft.value = textParts.value.map((p) => p.text).join('\n')
  editing.value = true
}
function submitEdit() {
  const parts = [...images.value, { type: 'text' as const, text: draft.value }]
  sync.send({ type: 'edit', message_id: props.message.id, parts })
  editing.value = false
}
function regenerate() {
  sync.send({ type: 'regenerate', message_id: props.message.id })
}
</script>

<template lang="pug">
.group.flex.flex-col.gap-1(:class="message.role === 'user' ? 'items-end' : 'items-start'")
  .max-w-full(:class="message.role === 'user' ? 'oc-message-user bg-primary text-primary-foreground px-3 py-2' : 'w-full'")
    template(v-if="message.role === 'user'")
      .flex.flex-wrap.gap-2.pb-1(v-if="images.length")
        img.max-h-40.rounded(v-for="img in images" :key="img.attachment_id" :src="api.attachmentUrl(img.attachment_id)")
      template(v-if="!editing")
        p.whitespace-pre-wrap.text-sm(v-for="(p, i) in textParts" :key="i") {{ p.text }}
      .flex.flex-col.gap-2(v-else)
        Textarea(v-model="draft" class="min-w-64 bg-background text-foreground")
        .flex.gap-2.justify-end
          Button(size="sm" variant="secondary" @click="editing = false") 取消
          Button(size="sm" @click="submitEdit") 发送
    template(v-else)
      details.mb-2.rounded.border.px-2.py-1.text-xs.text-muted-foreground(v-if="reasoning")
        summary 思考过程
        pre.whitespace-pre-wrap.pt-1 {{ reasoning }}
      MarkdownRender(mode="chat" :content="markdown" :final="!streaming" smooth-streaming="auto" :fade="false")
      //- Generated images are served by the same authenticated attachment route as uploads.
      .flex.flex-wrap.gap-2.pt-2(v-if="images.length")
        img.max-h-80.rounded.border(v-for="(img, i) in images" :key="i" :src="api.attachmentUrl(img.attachment_id)")
      p.text-xs.text-destructive(v-if="message.status === 'error'") 出错：{{ message.error }}
      p.text-xs.text-muted-foreground(v-else-if="message.status === 'aborted'") 已停止
  .flex.items-center.gap-2.text-xs.text-muted-foreground.transition-opacity(:class="actionsClass")
    BranchSwitcher(:message="message")
    button.inline-flex.items-center.gap-1(v-if="message.role === 'assistant' && !streaming" @click="regenerate")
      RefreshCw(class="size-3")
      span 重新生成
    button.inline-flex.items-center.gap-1(v-if="message.role === 'user' && !editing" @click="startEdit")
      Pencil(class="size-3")
      span 编辑
    span(v-if="message.usage") {{ message.usage.prompt ?? '?' }} / {{ message.usage.completion ?? '?' }} tokens
</template>
