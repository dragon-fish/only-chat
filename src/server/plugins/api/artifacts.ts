import type { Context } from 'cordis'
import { Hono } from 'hono'
import { CreateImageRunInputSchema } from '@/shared/artifacts'
import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { artifactRunInputs, artifactRuns, artifacts, attachments, messages } from '@/server/db/schema'
import { disposeRpcStub } from '@/server/rpc'
import { ArtifactRunInputError, createImageRun } from '../artifacts/runs'
import { authUserId, type ApiEnv } from './auth'
import { parseId } from './params'

const CursorSchema = z.strictObject({ created_at: z.number().int(), id: z.number().int().positive() })

function artifactDto(row: { artifact: typeof artifacts.$inferSelect; run: typeof artifactRuns.$inferSelect }) {
  return {
    ...row.artifact,
    prompt: row.run.prompt,
    params: row.run.params,
    source: row.run.source,
    operation: row.run.operation,
    status: row.run.status,
    provider_name: row.run.provider_name,
    provider_id: row.run.provider_id,
    interface_protocol: row.run.interface_protocol,
    model_id: row.run.model_id,
    model_name: row.run.model_name,
    conversation_id: row.run.conversation_id,
    message_id: row.run.message_id,
  }
}

async function withReferenceInputs(ctx: Context, rows: Array<typeof artifactRuns.$inferSelect>) {
  if (!rows.length) return []
  const inputs = await ctx.db.orm.select().from(artifactRunInputs)
    .where(inArray(artifactRunInputs.run_id, rows.map(row => row.id)))
    .orderBy(asc(artifactRunInputs.run_id), asc(artifactRunInputs.position))
  const byRun = new Map<number, number[]>()
  for (const input of inputs) {
    const list = byRun.get(input.run_id) ?? []
    list.push(input.attachment_id)
    byRun.set(input.run_id, list)
  }
  return rows.map(row => ({ ...row, reference_attachment_ids: byRun.get(row.id) ?? [] }))
}

export function artifactRoutes(ctx: Context) {
  const router = new Hono<ApiEnv>()
  router.post('/artifact-runs/image', async (c) => {
    const parsed = CreateImageRunInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
    try { return c.json(await createImageRun(ctx, authUserId(c), parsed.data), 202) }
    catch (error) {
      if (error instanceof ArtifactRunInputError) return c.json({ error: error.message }, error.status)
      throw error
    }
  })
  router.get('/artifact-runs/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const run = await ctx.db.orm.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, id), eq(artifactRuns.user_id, authUserId(c))) })
    return run ? c.json((await withReferenceInputs(ctx, [run]))[0]!) : c.json({ error: 'not found' }, 404)
  })
  router.get('/artifact-runs', async (c) => {
    const conversationId = Number(c.req.query('conversation_id'))
    if (!Number.isInteger(conversationId) || conversationId <= 0) return c.json({ error: 'invalid conversation' }, 400)
    const rows = await ctx.db.orm.select().from(artifactRuns).where(and(
      eq(artifactRuns.user_id, authUserId(c)), eq(artifactRuns.conversation_id, conversationId),
    )).orderBy(desc(artifactRuns.created_at), desc(artifactRuns.id))
    return c.json(await withReferenceInputs(ctx, rows))
  })
  router.post('/artifact-runs/:id/cancel', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const userId = authUserId(c)
    const [run] = await ctx.db.orm.update(artifactRuns).set({ status: 'cancelled', completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, id), eq(artifactRuns.user_id, userId), or(eq(artifactRuns.status, 'queued'), eq(artifactRuns.status, 'running')))).returning()
    const current = run ?? await ctx.db.orm.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, id), eq(artifactRuns.user_id, userId)) })
    if (!current) return c.json({ error: 'not found' }, 404)
    if (run) {
      if (run.message_id !== null && run.conversation_id !== null) {
        await ctx.db.orm.update(messages).set({ status: 'aborted', error: 'Image generation cancelled' }).where(and(
          eq(messages.id, run.message_id), eq(messages.conversation_id, run.conversation_id),
        ))
      }
      const instance = await ctx.env.ARTIFACT_WORKFLOW.get(run.workflow_instance_id)
      try {
        await instance.terminate()
      } catch { /* The persisted cancelled state remains authoritative. */ }
      finally { disposeRpcStub(instance) }
    }
    return c.json((await withReferenceInputs(ctx, [current]))[0]!)
  })
  router.get('/artifacts', async (c) => {
    const userId = authUserId(c)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30))
    const conversationId = c.req.query('conversation_id') === undefined ? undefined : Number(c.req.query('conversation_id'))
    if (conversationId !== undefined && (!Number.isInteger(conversationId) || conversationId <= 0)) return c.json({ error: 'invalid conversation' }, 400)
    const runId = c.req.query('run_id') === undefined ? undefined : Number(c.req.query('run_id'))
    if (runId !== undefined && (!Number.isInteger(runId) || runId <= 0)) return c.json({ error: 'invalid run' }, 400)
    let cursor: z.infer<typeof CursorSchema> | undefined
    const encoded = c.req.query('cursor')
    if (encoded) {
      try { cursor = CursorSchema.parse(JSON.parse(atob(encoded))) }
      catch { return c.json({ error: 'invalid cursor' }, 400) }
    }
    const rows = await ctx.db.orm.select({ artifact: artifacts, run: artifactRuns }).from(artifacts)
      .innerJoin(artifactRuns, eq(artifactRuns.id, artifacts.run_id))
      .where(and(
        eq(artifacts.user_id, userId), eq(artifacts.kind, 'image'), isNull(artifacts.deleted_at),
        conversationId === undefined ? undefined : eq(artifactRuns.conversation_id, conversationId),
        runId === undefined ? undefined : eq(artifacts.run_id, runId),
        cursor ? or(lt(artifacts.created_at, cursor.created_at), and(eq(artifacts.created_at, cursor.created_at), lt(artifacts.id, cursor.id))) : undefined,
      )).orderBy(desc(artifacts.created_at), desc(artifacts.id)).limit(limit + 1)
    const page = rows.slice(0, limit)
    const last = page.at(-1)?.artifact
    return c.json({
      artifacts: page.map(artifactDto),
      next_cursor: rows.length > limit && last ? btoa(JSON.stringify({ created_at: last.created_at, id: last.id })) : null,
    })
  })
  // Successes on this route are cached for a year; a refusal is about who is asking and is not.
  router.get('/artifacts/:id/content', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
    const [row] = await ctx.db.orm.select({ attachment: attachments }).from(artifacts)
      .innerJoin(attachments, eq(attachments.id, artifacts.attachment_id))
      .where(and(eq(artifacts.id, id), eq(artifacts.user_id, authUserId(c)), isNull(artifacts.deleted_at))).limit(1)
    if (!row) return c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
    const variant = c.req.query('variant')
    const headers = { 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' }
    if (variant === 'gallery' || variant === 'preview') {
      const stored = await ctx.assets.getBytes(row.attachment.r2_key)
      if (!stored) return c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
      const source = ctx.env.IMAGES.input(new Blob([stored.bytes as BlobPart], { type: stored.mime }).stream())
      let transformer: ImageTransformer | undefined
      let result: ImageTransformationResult | undefined
      try {
        transformer = source.transform({ width: variant === 'gallery' ? 512 : 1536, fit: 'scale-down' })
        result = await transformer.output({ format: 'image/webp' })
        return result.response({ headers })
      } catch {
        return new Response(stored.bytes as BodyInit, { headers: { ...headers, 'content-type': stored.mime } })
      } finally {
        if (result) disposeRpcStub(result)
        if (transformer && transformer !== source) disposeRpcStub(transformer)
        disposeRpcStub(source)
      }
    }
    const stored = await ctx.assets.getStream(row.attachment.r2_key)
    if (!stored) return c.json({ error: 'not found' }, 404, { 'cache-control': 'no-store' })
    return new Response(stored.body, { headers: {
      'content-type': row.attachment.mime, 'content-length': String(stored.size),
      ...headers,
    } })
  })
  router.get('/artifacts/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const [row] = await ctx.db.orm.select({ artifact: artifacts, run: artifactRuns }).from(artifacts)
      .innerJoin(artifactRuns, eq(artifactRuns.id, artifacts.run_id))
      .where(and(eq(artifacts.id, id), eq(artifacts.user_id, authUserId(c)), isNull(artifacts.deleted_at))).limit(1)
    return row ? c.json(artifactDto(row)) : c.json({ error: 'not found' }, 404)
  })
  router.delete('/artifacts/:id', async (c) => {
    const id = parseId(c.req.param('id'))
    if (id === null) return c.json({ error: 'not found' }, 404)
    const [row] = await ctx.db.orm.update(artifacts).set({ deleted_at: Date.now() })
      .where(and(eq(artifacts.id, id), eq(artifacts.user_id, authUserId(c)), isNull(artifacts.deleted_at))).returning({ id: artifacts.id })
    return row ? c.body(null, 204) : c.json({ error: 'not found' }, 404)
  })
  return router
}
