import { toast } from 'vue-sonner'
import type { ClientPluginSetup } from '@/client/plugins/host'
import CheckpointCard from './checkpoint-card.vue'
import { asNoticeEvent, createCompressCommand } from './compress'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.checkpoints.register(CheckpointCard)
  ctx.slashCommands.register('compress', createCompressCommand())
  // Automatic compaction has nobody waiting on it, so what went wrong is said here.
  ctx.events.on((payload) => {
    const notice = asNoticeEvent(payload)
    if (notice) toast.warning(notice.message)
  })
}
