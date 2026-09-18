import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AuditProvider, AuditStatus, AuditTranscript } from '@/shared/api'
import type { Conversation } from '@/shared/models'
import { attachments, models, providerInterfaces, providers } from '../../db/schema'
import { getConversation, listConversations, listMessages, toMessage } from '../hub/conversations'
import { serveAttachment } from './attachments'
import { authUserId, requireOwner, type ApiEnv } from './auth'
import { parseId } from './params'

/**
 * Read-only view of another account for the site owner. Nothing here writes, and an ordinary
 * administrator is refused: this is private conversation content, not account metadata.
 */
export function auditRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm
  const enabled = () => ctx.env.ENABLE_AUDIT === 'true'

  r.get('/admin/audit/status', requireOwner, c => c.json<AuditStatus>({ enabled: enabled() }))

  r.use('/admin/audit/users/:uid/*', async (c, next) => {
    if (!enabled()) return c.json({ error: 'not found' }, 404)
    return next()
  }, requireOwner, async (c, next) => {
    if (parseId(c.req.param('uid')!) === null) return c.json({ error: 'not found' }, 404)
    // Names who looked at whom; never the content served.
    console.log('audit', { viewer: authUserId(c), target: Number(c.req.param('uid')), path: c.req.path })
    await next()
  })

  r.get('/admin/audit/users/:uid/providers', async c => {
    const uid = Number(c.req.param('uid'))
    // Columns are listed on purpose: `api_key` must never be selected, not even to be dropped later.
    const rows = await db.select({
      id: providers.id, name: providers.name, enabled: providers.enabled,
      has_key: sql<number>`${providers.api_key} IS NOT NULL`, default_interface_id: providers.default_interface_id,
    }).from(providers).where(eq(providers.user_id, uid)).orderBy(providers.id)
    const ids = rows.map(row => row.id)
    const endpoints = ids.length === 0 ? [] : await db.select({
      id: providerInterfaces.id, provider_id: providerInterfaces.provider_id, protocol: providerInterfaces.protocol, base_url: providerInterfaces.base_url,
    }).from(providerInterfaces).where(inArray(providerInterfaces.provider_id, ids)).orderBy(providerInterfaces.id)
    const enabledModels = ids.length === 0 ? [] : await db.select({
      id: models.id, provider_id: models.provider_id, model_id: models.model_id, interface_id: models.interface_id,
      metadata: models.metadata_resolved, lab_id: models.lab_id,
    }).from(models).where(and(inArray(models.provider_id, ids), eq(models.enabled, true))).orderBy(models.sort, models.id)
    return c.json<AuditProvider[]>(rows.map(row => ({
      ...row,
      has_key: Boolean(row.has_key),
      interfaces: endpoints.filter(endpoint => endpoint.provider_id === row.id)
        .map(({ id, protocol, base_url }) => ({ id, protocol, base_url })),
      models: enabledModels.filter(model => model.provider_id === row.id).map(model => ({
        id: model.id, model_id: model.model_id, interface_id: model.interface_id,
        name: model.metadata.name ?? null, family: model.metadata.family ?? null, lab_id: model.lab_id,
      })),
    })))
  })

  r.get('/admin/audit/users/:uid/conversations', async c => c.json(await listConversations(
    db, Number(c.req.param('uid')), c.req.query('kind') === 'image' ? 'image' : 'chat',
  )))

  r.get('/admin/audit/users/:uid/conversations/:id/messages', async c => {
    const uid = Number(c.req.param('uid'))
    const id = parseId(c.req.param('id'))
    const conversation = id === null ? undefined : await getConversation(db, id, uid)
    if (!conversation) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(db, conversation.id, uid)
    return c.json<AuditTranscript>({ conversation: conversation as Conversation, messages: rows.map(row => toMessage(row)) })
  })

  r.get('/admin/audit/users/:uid/attachments/:id', async c => {
    const id = parseId(c.req.param('id'))
    const row = id === null ? undefined : await db.query.attachments.findFirst({
      where: and(eq(attachments.id, id), eq(attachments.user_id, Number(c.req.param('uid')))),
    })
    return serveAttachment(ctx, c, row)
  })

  return r
}
