<script setup lang="ts">
import { MonitorIcon, MoonIcon, SunIcon } from '@lucide/vue'
import { RouterLink } from 'vue-router'
import { useTheme } from '@/client/composables/use-theme'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Badge } from '@/client/ui/badge'
import { Button } from '@/client/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/client/ui/card'
import { Field, FieldDescription, FieldGroup, FieldTitle } from '@/client/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/client/ui/toggle-group'

const { preference, resolved, setPreference } = useTheme()
const options = [
  { value: 'system', label: '跟随系统', icon: MonitorIcon },
  { value: 'light', label: '浅色', icon: SunIcon },
  { value: 'dark', label: '深色', icon: MoonIcon },
] as const

function selectTheme(value: unknown) {
  if (value === 'system' || value === 'light' || value === 'dark') setPreference(value)
}
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 外观
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.flex-col.gap-2
        h1.text-2xl.font-semibold 外观
        p.text-sm.text-muted-foreground 选择适合你的阅读环境，设置仅保存在当前设备。
      FieldGroup
        Field
          FieldTitle#appearance-theme 主题
          ToggleGroup(type="single" variant="outline" :model-value="preference" aria-labelledby="appearance-theme" class="w-full" @update:model-value="selectTheme")
            ToggleGroupItem(v-for="option in options" :key="option.value" :value="option.value" class="min-h-10 flex-1")
              component(:is="option.icon" data-icon="inline-start")
              | {{ option.label }}
          FieldDescription(role="status") 当前显示为{{ resolved === 'dark' ? '深色' : '浅色' }}主题，选择后立即生效。
      Card
        CardHeader
          CardTitle 界面预览
          CardDescription 文字、对话与控件会随主题一起变化。
        CardContent(class="flex flex-col gap-4")
          .flex.justify-end
            .max-w-full.rounded-xl.bg-muted.p-3.text-sm 帮我整理一下今天的想法。
          .flex.flex-col.gap-2
            Badge(variant="secondary") only-chat
            p.text-sm.text-foreground 从一个问题开始，让思路慢慢清晰。
            p.text-sm.text-muted-foreground 次要信息保持轻盈，正文清楚易读。
        CardFooter
          Button(as-child variant="outline" class="min-h-10")
            RouterLink(to="/new") 开始聊天
</template>
