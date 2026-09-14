import type { ClientPluginSetup } from '@/client/plugins/host'
import { BROWSER_HANDOFF_TOOL_ID, BROWSER_USE_TOOL_ID } from '@/shared/plugins'
import { BrowserPluginEventSchema } from '../shared'
import BrowserHandoffCard from './browser-handoff-card.vue'
import BrowserTab from './browser-tab.vue'
import BrowserUseCard from './browser-use-card.vue'
import TurnShotsFooter from './turn-shots-footer.vue'
import { applySession, bind, requestAttention } from './state'

export const setup: ClientPluginSetup = (ctx) => {
  ctx.tools.register(BROWSER_USE_TOOL_ID, BrowserUseCard)
  ctx.tools.register(BROWSER_HANDOFF_TOOL_ID, BrowserHandoffCard)
  // The cards above are the run in order; this is what it produced, said once at the end.
  ctx.messageFooter.register(TurnShotsFooter)
  ctx.workspacePanel.register(BrowserTab)
  bind({ send: command => ctx.events.send(command), attention: request => ctx.workspacePanel.attention(request) })
  ctx.events.on((payload) => {
    const event = BrowserPluginEventSchema.safeParse(payload)
    if (!event.success) return
    // A browser that just came alive is worth a look; the shell decides whether it interrupts.
    if (applySession(event.data.state)) requestAttention()
  })
  return () => bind({ send: null, attention: null })
}
