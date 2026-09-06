<script setup lang="ts">
import { computed } from 'vue'
import { RotateCcw, Settings2 } from '@lucide/vue'
import { Input } from '@/client/ui/input'
import { Label } from '@/client/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/client/ui/popover'
import { Textarea } from '@/client/ui/textarea'
import type { SessionSettingSources, SessionSettingsForm, SettingSource } from '@/client/stores/sync'
import type { Project } from '@/shared/models'

const props = defineProps<{
  /**
   * The live form the chat view owns. Both this popover and the Composer's reasoning slider edit
   * fields of one session, so the state is shared by reference and edits are written in place;
   * `commit` asks the owner to persist the whole form.
   */
  form: SessionSettingsForm
  sources: SessionSettingSources
  /** The Project this session inherits from, if any — its values are shown as placeholders only. */
  project: Project | undefined
  /** A draft has no title yet: the session does not exist until the first message is sent. */
  hasSession: boolean
}>()
const emit = defineEmits<{ commit: [] }>()

const inherited = computed(() => props.project?.params)

const BADGES: Record<SettingSource, string> = {
  session: '会话覆盖',
  project: '继承自 Project',
  default: '默认',
}

function placeholder(value: number | undefined): string {
  return value === undefined ? '默认' : `继承 ${value}`
}
/** Restoring inheritance clears this field only; every other override stays untouched (spec §7.3). */
function restore(field: 'system_prompt' | 'temperature' | 'top_p' | 'max_tokens') {
  props.form[field] = ''
  emit('commit')
}
</script>

<template lang="pug">
Popover
  PopoverTrigger.inline-flex.items-center.gap-1.rounded-md.border.px-2.py-1.text-xs.text-muted-foreground(
    title="会话设置" class="hover:bg-accent hover:text-foreground")
    Settings2(class="size-3.5")
    span 会话设置
  //- Spec §8: the panel caps itself against the viewport and scrolls its own body. The primitive
  //- (Popper-backed, like Select) owns positioning: it opens toward whichever side has room and
  //- shifts to stay on-screen, so the trigger no longer needs to know it now lives in the top bar.
  PopoverContent(
    align="end" :side-offset="8"
    class="w-80 max-w-[85vw] max-h-(--reka-popover-content-available-height) gap-3 p-3 overflow-y-auto oc-scroll")
    div(v-if="hasSession")
      Label(class="text-xs") 标题
      Input(v-model="form.title" class="h-8 text-sm" placeholder="对话标题" @change="emit('commit')")

    .flex.flex-col.gap-1
      .flex.items-center.gap-2
        Label(class="text-xs") 会话提示词
        span.ml-auto.text-xs.text-muted-foreground {{ BADGES[sources.system_prompt] }}
        button.text-muted-foreground(
          v-if="sources.system_prompt === 'session'" type="button" title="恢复继承"
          class="hover:text-foreground" @click="restore('system_prompt')")
          RotateCcw(class="size-3.5")
      Textarea(
        v-model="form.system_prompt" rows="4" class="text-sm"
        placeholder="留空则只使用项目提示词" @change="emit('commit')")
      p.text-xs.text-muted-foreground 项目提示词在前、会话提示词在后，中间固定两个换行。
      details.text-xs.text-muted-foreground(v-if="project?.system_prompt")
        summary.cursor-pointer 项目提示词
        pre.whitespace-pre-wrap.pt-1 {{ project.system_prompt }}

    .flex.flex-col.gap-2
      .flex.items-center.gap-2
        Label(class="text-xs") temperature
        span.ml-auto.text-xs.text-muted-foreground {{ BADGES[sources.temperature] }}
        button.text-muted-foreground(
          v-if="sources.temperature === 'session'" type="button" title="恢复继承"
          class="hover:text-foreground" @click="restore('temperature')")
          RotateCcw(class="size-3.5")
      Input(
        v-model="form.temperature" type="number" min="0" max="2" step="0.1" class="h-8 text-sm"
        :placeholder="placeholder(inherited?.temperature)" @change="emit('commit')")

      .flex.items-center.gap-2
        Label(class="text-xs") top_p
        span.ml-auto.text-xs.text-muted-foreground {{ BADGES[sources.top_p] }}
        button.text-muted-foreground(
          v-if="sources.top_p === 'session'" type="button" title="恢复继承"
          class="hover:text-foreground" @click="restore('top_p')")
          RotateCcw(class="size-3.5")
      Input(
        v-model="form.top_p" type="number" min="0" max="1" step="0.05" class="h-8 text-sm"
        :placeholder="placeholder(inherited?.top_p)" @change="emit('commit')")

      .flex.items-center.gap-2
        Label(class="text-xs") 最大 tokens
        span.ml-auto.text-xs.text-muted-foreground {{ BADGES[sources.max_tokens] }}
        button.text-muted-foreground(
          v-if="sources.max_tokens === 'session'" type="button" title="恢复继承"
          class="hover:text-foreground" @click="restore('max_tokens')")
          RotateCcw(class="size-3.5")
      Input(
        v-model="form.max_tokens" type="number" min="1" step="1" class="h-8 text-sm"
        :placeholder="placeholder(inherited?.max_tokens)" @change="emit('commit')")

    p.text-xs.text-muted-foreground(v-if="!hasSession") 这些设置会随第一条消息一起创建会话。
</template>
