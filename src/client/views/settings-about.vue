<script setup lang="ts">
import { ExternalLinkIcon } from '@lucide/vue'
import PageBackButton from '@/client/components/layout/page-back-button.vue'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/client/ui/card'

/**
 * The Appropriate Legal Notices the AGPL asks an interactive program to display (sections 0 and 5(d)).
 *
 * The "Powered by Only Chat" line and its link are a licence term (ATTRIBUTION.md, AGPL section
 * 7(b)): every version others use must keep them, legible and linked. Do not remove, hide or reword
 * them. `SOURCE_URL` is different — a modified version must point it at its own source (section 13).
 */
const UPSTREAM_URL = 'https://github.com/dragon-fish/only-chat'
const SOURCE_URL = UPSTREAM_URL

const links = [
  { label: '源代码', href: SOURCE_URL },
  { label: '许可证（AGPL-3.0）', href: `${UPSTREAM_URL}/blob/main/LICENSE` },
  { label: '第三方组件', href: `${UPSTREAM_URL}/blob/main/NOTICE.md` },
  { label: '名称与 logo', href: `${UPSTREAM_URL}/blob/main/TRADEMARKS.md` },
]
</script>

<template lang="pug">
.h-full.min-h-0.overflow-hidden
  Teleport(to="#page-header" defer)
    PageBackButton
    span.truncate.text-sm.font-medium 关于
  .oc-scroll.h-full.overflow-y-auto
    .mx-auto.flex.w-full.max-w-3xl.flex-col.gap-6.p-4(class="md:p-6 lg:p-8")
      .flex.items-center.gap-4
        img.size-14(src="/logo/only-chat-indigo.svg" alt="")
        .flex.flex-col.gap-1
          h1.text-2xl.font-semibold Only Chat
          p.text-sm.font-medium Only Chat, not only chat.
          p.text-sm.text-muted-foreground 开源自托管，揣兜随心聊；能简亦能强，插件随你造。
      Card
        CardHeader
          CardTitle 许可与署名
          CardDescription
            a.font-medium.text-foreground.underline-offset-4(:href="UPSTREAM_URL" target="_blank" rel="noopener" class="hover:underline" data-attribution) Powered by Only Chat
            |  · © dragon-fish 及 only-chat 贡献者
        CardContent(class="flex flex-col gap-4")
          p.text-sm.text-muted-foreground 本程序是自由软件，以 GNU Affero 通用公共许可证第 3 版（AGPL-3.0-only）发布，不提供任何担保。
          ul.flex.flex-col.gap-2
            li(v-for="link in links" :key="link.href")
              a.inline-flex.items-center.gap-1.text-sm.underline-offset-4(:href="link.href" target="_blank" rel="noopener" class="hover:underline")
                | {{ link.label }}
                ExternalLinkIcon(class="size-3.5")
</template>
