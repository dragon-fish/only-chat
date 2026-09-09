import type { Context } from 'cordis'
import { and, asc, eq } from 'drizzle-orm'
import { artifactLinks, artifactRunInputs, artifactRuns, artifacts, attachments, messages } from '@/server/db/schema'
import { MAX_UPLOAD_BYTES, r2Key } from '../api/attachments'
import { getAttachment, getModel, getProvider, getProviderInterface } from '../hub/conversations'

const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2_000)
}

export async function executeImageRun(ctx: Context, userId: number, runId: number): Promise<void> {
  const db = ctx.db.orm
  const run = await db.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, runId), eq(artifactRuns.user_id, userId)) })
  if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return
  const [claimed] = await db.update(artifactRuns).set({ status: 'running', started_at: run.started_at ?? Date.now() })
    .where(and(eq(artifactRuns.id, run.id), eq(artifactRuns.user_id, userId), eq(artifactRuns.status, 'queued'))).returning()
  if (!claimed && run.status !== 'running') return

  try {
    if (run.provider_id === null || run.interface_id === null) throw new Error('Image provider configuration no longer exists')
    const [provider, model, selected] = await Promise.all([
      getProvider(db, run.provider_id, userId),
      getModel(db, run.provider_id, run.model_id, userId),
      getProviderInterface(db, run.interface_id, userId),
    ])
    if (!provider || !model || !selected || selected.provider_id !== provider.id) throw new Error('Image provider configuration no longer exists')
    if (provider.credential_version !== run.credential_version) throw new Error('Image provider credentials changed before generation started')
    const inputRows = await db.select().from(artifactRunInputs).where(eq(artifactRunInputs.run_id, run.id)).orderBy(asc(artifactRunInputs.position))
    const references = await Promise.all(inputRows.map(async (input) => {
      const attachment = await getAttachment(db, input.attachment_id, userId)
      if (!attachment) throw new Error('Reference attachment no longer exists')
      const stored = await ctx.assets.getBytes(attachment.r2_key)
      if (!stored) throw new Error('Reference attachment content is missing')
      return { bytes: stored.bytes as Uint8Array<ArrayBuffer>, mime: attachment.mime, filename: `reference-${input.position}` }
    }))
    const client = await ctx.llm.createImages(provider, selected)
    const outputs = await client.generate({
      modelId: run.model_id, prompt: run.prompt, references, params: run.params,
      idempotencyKey: run.workflow_instance_id,
    })
    const current = await db.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, run.id), eq(artifactRuns.user_id, userId)) })
    if (current?.status !== 'running') return
    const imageParts: Array<{ type: 'image'; attachment_id: number; artifact_id: number }> = []
    for (const [outputIndex, output] of outputs.entries()) {
      if (!ACCEPTED_MIME.has(output.mime)) throw new Error(`Unsupported generated image type: ${output.mime}`)
      if (output.bytes.byteLength === 0 || output.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('Generated image has an invalid size')
      const digest = await sha256(output.bytes)
      let dimensions = run.params.size
      try {
        const info = await ctx.env.IMAGES.info(new Blob([output.bytes as BlobPart], { type: output.mime }).stream())
        if ('width' in info) dimensions = { width: info.width, height: info.height }
      } catch { /* Requested dimensions remain a useful fallback for unsupported or malformed metadata. */ }
      let attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, digest)) })
      if (!attachment) {
        const key = r2Key(userId, digest)
        await ctx.assets.put(key, output.bytes, output.mime)
        await db.insert(attachments).values({
          user_id: userId, sha256: digest, mime: output.mime, size: output.bytes.byteLength,
          width: dimensions?.width ?? null, height: dimensions?.height ?? null,
          r2_key: key, origin: 'generated', created_at: Date.now(),
        }).onConflictDoNothing()
        attachment = await db.query.attachments.findFirst({ where: and(eq(attachments.user_id, userId), eq(attachments.sha256, digest)) })
        if (!attachment) throw new Error('Could not persist generated image')
      }
      await db.insert(artifacts).values({
        user_id: userId, run_id: run.id, kind: 'image', attachment_id: attachment.id, output_index: outputIndex,
        width: attachment.width, height: attachment.height, mime: attachment.mime, created_at: Date.now(),
      }).onConflictDoNothing()
      const artifact = await db.query.artifacts.findFirst({ where: and(eq(artifacts.run_id, run.id), eq(artifacts.output_index, outputIndex)) })
      if (!artifact) throw new Error('Could not publish generated Artifact')
      if (run.conversation_id !== null && run.message_id !== null) {
        await db.insert(artifactLinks).values({
          artifact_id: artifact.id, conversation_id: run.conversation_id, message_id: run.message_id,
          tool_call_id: run.tool_call_id, purpose: 'output',
        }).onConflictDoNothing()
      }
      imageParts.push({ type: 'image', attachment_id: attachment.id, artifact_id: artifact.id })
    }
    if (run.message_id !== null && run.conversation_id !== null) {
      await db.update(messages).set({ parts: imageParts }).where(and(
        eq(messages.id, run.message_id), eq(messages.conversation_id, run.conversation_id),
      ))
    }
    await db.update(artifactRuns).set({ status: 'completed', error: null, completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, run.id), eq(artifactRuns.user_id, userId), eq(artifactRuns.status, 'running')))
  } catch (error) {
    await db.update(artifactRuns).set({ status: 'failed', error: safeError(error), completed_at: Date.now() })
      .where(and(eq(artifactRuns.id, run.id), eq(artifactRuns.user_id, userId), eq(artifactRuns.status, 'running')))
  }
}
