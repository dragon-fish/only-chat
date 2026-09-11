import type { Context } from 'cordis'
import { Hono } from 'hono'
import { z } from 'zod'
import { findPluginManifest } from '@/shared/plugin-manifests'
import { authUserId, type ApiEnv } from './auth'

/** `null` clears a field; a key the form did not send keeps whatever is stored. */
const PatchSchema = z.record(z.string(), z.unknown())

/**
 * Plugin configuration travels over REST, not the settings WebSocket: `settings.updated` fans the
 * whole `UserSettings` object out to every connection a user has open, and a credential must never
 * enter that path.
 */
export function pluginConfigRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()

  r.put('/plugins/:pluginId/config', async (c) => {
    const pluginId = c.req.param('pluginId')
    const manifest = findPluginManifest(pluginId)
    if (!manifest?.configSchema) return c.json({ error: 'not found' }, 404)
    const patch = PatchSchema.safeParse(await c.req.json().catch(() => null))
    if (!patch.success) return c.json({ error: 'Invalid configuration payload' }, 400)
    try {
      await ctx.pluginConfig.write(authUserId(c), pluginId, patch.data)
    } catch (error) {
      // Schema failures are the operator's to fix and their messages are written for them; nothing
      // here echoes a submitted value back.
      return c.json({ error: error instanceof z.ZodError ? error.issues[0]?.message ?? '配置无效' : '保存失败' }, 400)
    }
    return c.json(await ctx.pluginConfig.status(authUserId(c)))
  })

  return r
}
