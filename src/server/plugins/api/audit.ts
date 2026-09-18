import type { Context } from 'cordis'
import { Hono } from 'hono'
import { and, asc, desc, eq, gte, inArray, lt, sql, type AnyColumn, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { AuditConversationRow, AuditPage, AuditProviderRow, AuditTranscript } from '@/shared/api'
import type { Conversation } from '@/shared/models'
import { attachments, conversations, messages, models, providerInterfaces, providers, users } from '../../db/schema'
import { listMessages, toMessage } from '../hub/conversations'
import { serveAttachment } from './attachments'
import { authUserId, requireOwner, type ApiEnv } from './auth'
import { parseId } from './params'

const CURSOR = /^(\d+)\.(\d+)$/

const pagingSchema = {
  user: z.coerce.number().int().positive().optional(),
  limit: z.enum(['50', '100', '250', '500']).default('50').transform(Number),
  after: z.string().regex(CURSOR).optional(),
  before: z.string().regex(CURSOR).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
}
const refineCursor = (query: { after?: string, before?: string }) => !(query.after && query.before)

const ConversationQuerySchema = z.object({
  ...pagingSchema,
  sort: z.enum(['id', 'created', 'active']).default('id'),
  since: z.coerce.number().int().nonnegative().optional(),
  until: z.coerce.number().int().nonnegative().optional(),
}).refine(refineCursor)
const ProviderQuerySchema = z.object({ ...pagingSchema, sort: z.literal('id').default('id') }).refine(refineCursor)

type Paging = z.infer<typeof ConversationQuerySchema> | z.infer<typeof ProviderQuerySchema>

/**
 * Keyset paging on `(sort column, id)`, so a row inserted while someone pages can neither repeat nor
 * vanish. `before` walks against the sort direction, and its rows are flipped back into sort order.
 */
function keyset(query: Paging, column: AnyColumn, id: AnyColumn) {
  const cursor = query.after ?? query.before
  const backward = query.before !== undefined
  const ascending = (query.dir === 'asc') !== backward
  const match = cursor ? CURSOR.exec(cursor) : null
  const where: SQL | undefined = match
    ? ascending ? sql`(${column}, ${id}) > (${Number(match[1])}, ${Number(match[2])})` : sql`(${column}, ${id}) < (${Number(match[1])}, ${Number(match[2])})`
    : undefined
  const orderBy = ascending ? [asc(column), asc(id)] : [desc(column), desc(id)]
  function page<T>(fetched: T[], key: (row: T) => [number, number]): { rows: T[], next: string | null, prev: string | null } {
    const more = fetched.length > query.limit
    const rows = fetched.slice(0, query.limit)
    if (backward) rows.reverse()
    const encode = (row: T | undefined) => row === undefined ? null : key(row).join('.')
    return backward
      ? { rows, prev: more ? encode(rows[0]) : null, next: encode(rows.at(-1)) }
      : { rows, next: more ? encode(rows.at(-1)) : null, prev: cursor ? encode(rows[0]) : null }
  }
  return { where, orderBy, page }
}

/**
 * Fail-closed: only the exact string enables the audit. The parameter is `string` on purpose — the
 * generated `Env` types the variable as the literal declared in `wrangler.jsonc`, while a deploy
 * command or `.dev.vars` may set anything.
 */
export function isAuditEnabled(value: string | undefined): boolean {
  return value === 'true'
}

/** D1 binds at most 100 parameters per statement, so a 500-row page is looked up in slices. */
async function inSlices<T>(ids: number[], query: (slice: number[]) => Promise<T[]>): Promise<T[]> {
  const slices: number[][] = []
  for (let i = 0; i < ids.length; i += 90) slices.push(ids.slice(i, i + 90))
  return (await Promise.all(slices.map(query))).flat()
}

/**
 * Read-only, site-wide listings for the site owner, in the manner of MediaWiki special pages.
 * Nothing here writes, and an ordinary administrator is refused: this is private conversation
 * content, not account metadata.
 */
export function auditRoutes(ctx: Context) {
  const r = new Hono<ApiEnv>()
  const db = ctx.db.orm
  const enabled = () => isAuditEnabled(ctx.env.ENABLE_AUDIT)
  const owner = { id: users.id, name: users.name, email: users.email }

  // Whether to show the pages at all is answered by `/api/site-config`, for the owner only.
  r.use('/admin/audit/*', async (c, next) => {
    if (!enabled()) return c.json({ error: 'not found' }, 404)
    return requireOwner(c, async () => {
      const url = new URL(c.req.url)
      // Names who looked at what; never the content served.
      console.log('audit', { viewer: authUserId(c), path: url.pathname + url.search })
      await next()
    })
  })

  r.get('/admin/audit/conversations', async c => {
    const query = ConversationQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid query' }, 400)
    const q = query.data
    const column = { id: conversations.id, created: conversations.created_at, active: conversations.updated_at }[q.sort]
    const { where, orderBy, page } = keyset(q, column, conversations.id)
    const latestAssistant = (field: AnyColumn) => sql`(SELECT ${field} FROM ${messages}
      WHERE ${messages.conversation_id} = ${conversations.id} AND ${messages.role} = 'assistant' AND ${messages.model_id} IS NOT NULL
      ORDER BY ${messages.id} DESC LIMIT 1)`
    const usageSum = (key: string) => sql<number>`(SELECT COALESCE(SUM(json_extract(${messages.usage}, ${key})), 0)
      FROM ${messages} WHERE ${messages.conversation_id} = ${conversations.id})`
    const fetched = await db.select({
      id: conversations.id, title: conversations.title, kind: conversations.kind, archived_at: conversations.archived_at,
      created_at: conversations.created_at, updated_at: conversations.updated_at, owner,
      model_provider_id: latestAssistant(messages.provider_id).mapWith(Number),
      model_id: latestAssistant(messages.model_id).mapWith(String),
      input: usageSum('$.prompt').mapWith(Number), output: usageSum('$.completion').mapWith(Number),
    }).from(conversations).innerJoin(users, eq(users.id, conversations.user_id)).where(and(
      q.user === undefined ? undefined : eq(conversations.user_id, q.user),
      q.since === undefined ? undefined : gte(conversations.updated_at, q.since),
      q.until === undefined ? undefined : lt(conversations.updated_at, q.until),
      where,
    )).orderBy(...orderBy).limit(q.limit + 1)
    const result = page(fetched, row => [row[({ id: 'id', created: 'created_at', active: 'updated_at' } as const)[q.sort]], row.id])
    const providerIds = [...new Set(result.rows.flatMap(row => row.model_provider_id ? [row.model_provider_id] : []))]
    const names = await inSlices(providerIds, slice => db.select({ provider_id: models.provider_id, model_id: models.model_id, metadata: models.metadata_resolved })
      .from(models).where(inArray(models.provider_id, slice)))
    return c.json<AuditPage<AuditConversationRow>>({
      ...result,
      rows: result.rows.map(row => ({
        id: row.id, title: row.title, kind: row.kind, archived: row.archived_at !== null,
        created_at: row.created_at, updated_at: row.updated_at, owner: row.owner,
        model: row.model_provider_id && row.model_id ? {
          provider_id: row.model_provider_id, model_id: row.model_id,
          name: names.find(name => name.provider_id === row.model_provider_id && name.model_id === row.model_id)?.metadata.name ?? null,
        } : null,
        tokens: { input: row.input, output: row.output },
      })),
    })
  })

  r.get('/admin/audit/conversations/:id', async c => {
    const id = parseId(c.req.param('id'))
    const found = id === null ? undefined : (await db.select({ conversation: conversations, owner }).from(conversations)
      .innerJoin(users, eq(users.id, conversations.user_id)).where(eq(conversations.id, id)))[0]
    if (!found) return c.json({ error: 'not found' }, 404)
    const rows = await listMessages(db, found.conversation.id, found.conversation.user_id)
    return c.json<AuditTranscript>({ conversation: found.conversation as Conversation, owner: found.owner, messages: rows.map(row => toMessage(row)) })
  })

  r.get('/admin/audit/providers', async c => {
    const query = ProviderQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid query' }, 400)
    const q = query.data
    const { where, orderBy, page } = keyset(q, providers.id, providers.id)
    // Columns are listed on purpose: `api_key` must never be selected, not even to be dropped later.
    const fetched = await db.select({
      id: providers.id, name: providers.name, enabled: providers.enabled, created_at: providers.created_at,
      has_key: sql<number>`${providers.api_key} IS NOT NULL`.mapWith(Boolean), default_interface_id: providers.default_interface_id, owner,
    }).from(providers).innerJoin(users, eq(users.id, providers.user_id)).where(and(
      q.user === undefined ? undefined : eq(providers.user_id, q.user), where,
    )).orderBy(...orderBy).limit(q.limit + 1)
    const result = page(fetched, row => [row.id, row.id])
    const ids = result.rows.map(row => row.id)
    const endpoints = await inSlices(ids, slice => db.select({
      id: providerInterfaces.id, provider_id: providerInterfaces.provider_id, protocol: providerInterfaces.protocol, base_url: providerInterfaces.base_url,
    }).from(providerInterfaces).where(inArray(providerInterfaces.provider_id, slice)).orderBy(providerInterfaces.id))
    const enabledModels = await inSlices(ids, slice => db.select({
      id: models.id, provider_id: models.provider_id, model_id: models.model_id, metadata: models.metadata_resolved, lab_id: models.lab_id,
    }).from(models).where(and(inArray(models.provider_id, slice), eq(models.enabled, true))).orderBy(models.sort, models.id))
    return c.json<AuditPage<AuditProviderRow>>({
      ...result,
      rows: result.rows.map(row => ({
        ...row,
        interfaces: endpoints.filter(endpoint => endpoint.provider_id === row.id)
          .map(({ id, protocol, base_url }) => ({ id, protocol, base_url })),
        models: enabledModels.filter(model => model.provider_id === row.id).map(model => ({
          id: model.id, model_id: model.model_id,
          name: model.metadata.name ?? null, family: model.metadata.family ?? null, lab_id: model.lab_id,
        })),
      })),
    })
  })

  r.get('/admin/audit/attachments/:id', async c => {
    const id = parseId(c.req.param('id'))
    const row = id === null ? undefined : await db.query.attachments.findFirst({ where: eq(attachments.id, id) })
    return serveAttachment(ctx, c, row)
  })

  return r
}
