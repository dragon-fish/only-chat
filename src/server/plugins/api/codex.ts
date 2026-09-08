import type { Context } from 'cordis'
import { Hono } from 'hono'
import { z } from 'zod'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { CodexOAuthPollResponseSchema, CodexOAuthStartResponseSchema } from '@/shared/api'
import { readProviderDto } from './provider-read'
import { reconcileProviderModels } from './provider-model-sync'
import { parseId } from './params'

export function codexRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const flowIdSchema = z.string().uuid()

  r.post('/codex/oauth/start', async c => {
    try {
      const grant = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).startCodexOAuth()
      return c.json(CodexOAuthStartResponseSchema.parse(grant), 201)
    } catch { return c.json({ error: 'Could not start Codex authorization' }, 502) }
  })

  r.post('/providers/:id/codex/reconnect', async c => {
    const id = parseId(c.req.param('id'))
    const provider = id === null ? null : await readProviderDto(ctx, id)
    if (!provider || provider.kind !== 'codex-oauth') return c.json({ error: 'Codex provider not found' }, 404)
    try {
      const grant = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).startCodexOAuth(provider.id)
      return c.json(CodexOAuthStartResponseSchema.parse(grant), 201)
    } catch { return c.json({ error: 'Could not start Codex authorization' }, 502) }
  })

  r.post('/providers/:id/codex/disconnect', async c => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'Codex provider not found' }, 404)
    try {
      const result = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).disconnectCodexProvider(id)
      if (result.status === 'not-found') return c.json({ error: 'Codex provider not found' }, 404)
      if (result.status === 'conflict') return c.json({ error: 'Codex credentials changed concurrently; reload and retry' }, 409)
      return c.body(null, 204)
    } catch { return c.json({ error: 'Could not disconnect Codex provider' }, 502) }
  })

  r.post('/codex/oauth/:flowId/poll', async c => {
    const flowId = flowIdSchema.safeParse(c.req.param('flowId'))
    if (!flowId.success) return c.json({ error: 'Invalid authorization flow' }, 400)
    try {
      const result = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).pollCodexOAuth(flowId.data)
      if (result.status !== 'complete') return c.json(CodexOAuthPollResponseSchema.parse(result))
      const provider = await readProviderDto(ctx, result.providerId)
      if (!provider) return c.json({ status: 'failed', error: 'Codex provider no longer exists' } as const)
      let warning = result.modelListError ?? undefined
      if (!warning) {
        try {
          await reconcileProviderModels(ctx, result.providerId, result.modelIds, { enableNew: result.initialConnection })
        } catch { warning = 'Codex connected, but model synchronization failed' }
      }
      return c.json(CodexOAuthPollResponseSchema.parse({ status: 'complete', provider, ...(warning ? { model_sync_warning: warning } : {}) }))
    } catch { return c.json({ status: 'failed', error: 'Codex authorization failed' } as const) }
  })

  r.delete('/codex/oauth/:flowId', async c => {
    const flowId = flowIdSchema.safeParse(c.req.param('flowId'))
    if (!flowId.success) return c.json({ error: 'Invalid authorization flow' }, 400)
    try {
      await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).cancelCodexOAuth(flowId.data)
      return c.body(null, 204)
    } catch { return c.json({ error: 'Could not cancel Codex authorization' }, 502) }
  })

  return r
}
