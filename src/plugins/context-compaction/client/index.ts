import { toast } from 'vue-sonner'
import type { ClientPluginSetup } from '@/client/plugins/host'
import { routeParamToId } from '@/client/lib/route-params'
import { router } from '@/client/router'
import CheckpointCard from './checkpoint-card.vue'
import { asNoticeEvent, createCompressCommand } from './compress'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.checkpoints.register(CheckpointCard)
  ctx.slashCommands.register('compress', createCompressCommand())
  // Automatic compaction has nobody waiting on it, so what went wrong is said here — but only in
  // the conversation it happened to: every connected device receives the event.
  ctx.events.on((payload) => {
    const notice = asNoticeEvent(payload)
    if (!notice) return
    const raw = router.currentRoute.value.params as Record<string, string | string[] | undefined>
    if (routeParamToId(raw.conversationId) === notice.conversationId) toast.warning(notice.message)
  })
}
