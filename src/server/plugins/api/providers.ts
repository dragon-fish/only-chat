import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq, exists } from 'drizzle-orm'
import { DEFAULT_USER_ID } from '@/shared/constants'
import { CodexProviderUpdateSchema, ProviderWriteInputSchema } from '@/shared/api'
import { providerInterfaces, providerOAuthCredentials, providers } from '../../db/schema'
import { decryptSecret } from '../llm/crypto'
import { listRemoteModels } from '../llm/list-models'
import { cleanupProviderFilesBeforeChange, invalidatedProviderFiles } from '../files-cleanup'
import { parseId } from './params'
import { ProviderWriteError, writeCodexProvider, writeProvider } from './provider-write'
import { listProviderDtos, readProviderDto } from './provider-read'
import { ModelSourceConflict } from './model-write'
import { ProviderModelSyncNotFound, reconcileProviderModels } from './provider-model-sync'

export function providerRoutes(ctx: Context) {
  const r = new Hono<{ Bindings: Env }>()
  const db = ctx.db.orm
  const owned = (id: number) => and(eq(providers.id, id), eq(providers.user_id, DEFAULT_USER_ID))

  r.get('/providers', async c => c.json(await listProviderDtos(ctx)))

  r.on(['POST', 'PUT'], ['/providers', '/providers/:id'], async c => {
    const id = c.req.param('id') === undefined ? undefined : parseId(c.req.param('id')!)
    if (id === null || (c.req.method === 'PUT' && id === undefined) || (c.req.method === 'POST' && id !== undefined)) return c.json({ error: 'not found' }, 404)
    const provider = id === undefined ? undefined : await db.query.providers.findFirst({ where: owned(id) })
    if (id !== undefined && !provider) return c.json({ error: 'not found' }, 404)
    if (provider?.kind === 'codex-oauth') {
      const parsed = CodexProviderUpdateSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return c.json({ error: 'invalid input' }, 400)
      try {
        await writeCodexProvider(ctx, provider.id, parsed.data)
        return c.json(await readProviderDto(ctx, provider.id))
      } catch (error) {
        if (error instanceof ProviderWriteError) return c.json({ error: error.message }, error.status)
        return c.json({ error: 'Codex provider update failed' }, 500)
      }
    }
    const parsed = ProviderWriteInputSchema.safeParse(await c.req.json())
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try {
      const result = await writeProvider(ctx, parsed.data, id)
      if (result.warning) c.header('X-Provider-Association-Warning', result.warning)
      return c.json(result.provider, id === undefined ? 201 : 200)
    } catch (error) {
      if (error instanceof ProviderWriteError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })

  r.delete('/providers/:id', async c => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id) })
    if (provider?.kind === 'codex-oauth') {
      try {
        const result = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).prepareCodexDelete(id)
        if (result.status === 'conflict') return c.json({ error: 'Codex credentials changed concurrently; reload and retry' }, 409)
        if (result.status === 'not-found') return c.json({ error: 'Codex provider not found' }, 404)
        const deleted = await db.delete(providers).where(and(owned(id), eq(providers.kind, 'codex-oauth'), exists(
          db.select().from(providerOAuthCredentials).where(and(
            eq(providerOAuthCredentials.provider_id, id), eq(providerOAuthCredentials.status, 'disconnected'), eq(providerOAuthCredentials.revision, result.revision),
          )),
        ))).returning({ id: providers.id })
        if (!deleted.length && await db.query.providers.findFirst({ where: owned(id) })) return c.json({ error: 'Codex credentials changed concurrently; reload and retry' }, 409)
        return c.body(null, 204)
      } catch { return c.json({ error: 'Could not delete Codex provider' }, 502) }
    }
    if (provider) {
      const interfaces = await db.select().from(providerInterfaces).where(eq(providerInterfaces.provider_id, id))
      await cleanupProviderFilesBeforeChange(ctx, provider, interfaces, invalidatedProviderFiles(provider))
    }
    await db.delete(providers).where(owned(id))
    return c.body(null, 204)
  })

  r.post('/providers/:id/fetch-models', async c => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const provider = await db.query.providers.findFirst({ where: owned(id) })
    if (!provider) return c.json({ error: 'not found' }, 404)
    if (provider.kind === 'codex-oauth') {
      try {
        const ids = await c.env.USER_HUB.getByName(String(DEFAULT_USER_ID)).listCodexModels(id)
        return c.json(await reconcileProviderModels(ctx, id, ids))
      } catch (error) {
        if (error instanceof ProviderModelSyncNotFound) return c.json({ error: error.message }, 404)
        if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
        return c.json({ error: 'Codex model listing failed' }, 502)
      }
    }
    const endpoint = provider.default_interface_id === null ? undefined : await db.query.providerInterfaces.findFirst({
      where: and(eq(providerInterfaces.id, provider.default_interface_id), eq(providerInterfaces.provider_id, id)),
    })
    if (!endpoint) return c.json({ error: 'Configure a default interface first' }, 400)
    if (endpoint.protocol === 'vertex-compatible') return c.json({ error: 'Model listing is not supported for Vertex-compatible interfaces' }, 400)
    const key = provider.api_key ? await decryptSecret(ctx.env.KEY_ENCRYPTION_SECRET, provider.api_key) : null
    const ids = [...new Set(await listRemoteModels(endpoint, key))]
    try {
      return c.json(await reconcileProviderModels(ctx, id, ids))
    } catch (error) {
      if (error instanceof ProviderModelSyncNotFound) return c.json({ error: error.message }, 404)
      if (error instanceof ModelSourceConflict) return c.json({ error: error.message }, 409)
      throw error
    }
  })

  return r
}
