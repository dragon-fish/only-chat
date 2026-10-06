import type { Context } from 'cordis'
import { getUser } from '@/server/plugins/hub/conversations'
import { CONTEXT_COMPACTION_CONFIG_SCHEMA, CONTEXT_COMPACTION_PLUGIN_ID, type CompactionEvent } from '../shared'
import { handleCompactionCommand } from './command'
import { createContextManager } from './manager'

/**
 * The hub half of context compaction: the context manager the core runs around every turn, `/compress`,
 * and the notices for automatic compactions that did not work. It has no tools and no Worker half.
 */
export const ContextCompactionServerPlugin = {
  name: 'context-compaction',
  inject: ['db', 'llm', 'pluginConfig', 'pluginChannel', 'contextManager', 'hub'] as const,
  apply(ctx: Context) {
    const notify = (event: CompactionEvent) => ctx.hub.broadcastPlugin(CONTEXT_COMPACTION_PLUGIN_ID, event)

    ctx.contextManager.register(CONTEXT_COMPACTION_PLUGIN_ID, createContextManager({
      db: ctx.db.orm,
      llm: ctx.llm,
      config: async userId => CONTEXT_COMPACTION_CONFIG_SCHEMA.parse(await ctx.pluginConfig.read(userId, CONTEXT_COMPACTION_PLUGIN_ID)),
      settings: async (userId) => {
        const user = await getUser(ctx.db.orm, userId)
        if (!user) throw new Error('user not found')
        return user.settings
      },
      notify,
    }))

    ctx.pluginChannel.onCommand(CONTEXT_COMPACTION_PLUGIN_ID, (payload, hub) => handleCompactionCommand(hub, payload))

    // A manual compaction answers its own request; an automatic one has nobody waiting for it.
    ctx.on('checkpoint/failed', ({ conversationId, trigger, error }) => {
      if (trigger === 'manual') return
      notify({ type: 'notice', conversationId, kind: 'failed', message: `上下文压缩失败：${error}` })
        .catch(err => console.error('reporting a failed compaction failed', err))
    })
  },
}
