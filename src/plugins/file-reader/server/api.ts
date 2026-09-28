import type { Context } from 'cordis'
import { Hono } from 'hono'
import { FILE_READER_PLUGIN_ID } from '@/shared/plugins'
import { authUserId, type ApiEnv } from '@/server/plugins/api/auth'
import { parseId } from '@/server/plugins/api/params'
import { getConversation } from '@/server/plugins/hub/conversations'
import { listConversationAssets } from './list'

/**
 * The plugin's HTTP surface, on the Worker where the API lives. The tool half runs inside the
 * UserHub, so the two are separate cordis plugins rather than one that would sit PENDING on
 * whichever service its side does not have.
 */
export const FileReaderApiPlugin = {
  name: 'file-reader-api',
  inject: ['pluginApi', 'db'] as const,
  apply(ctx: Context) {
    const r = new Hono<ApiEnv>()
    /** Every file of the conversation, across branches, for the file panel (spec §4.7). */
    r.get('/conversations/:id/assets', async (c) => {
      const userId = authUserId(c)
      const id = parseId(c.req.param('id'))
      if (id === null) return c.json({ error: 'not found' }, 404)
      if (!(await getConversation(ctx.db.orm, id, userId))) return c.json({ error: 'not found' }, 404)
      return c.json({ assets: await listConversationAssets(ctx.db.orm, userId, id) })
    })
    ctx.pluginApi.register(FILE_READER_PLUGIN_ID, r)
  },
}
