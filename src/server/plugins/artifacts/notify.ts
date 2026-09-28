import { and, asc, eq, isNull } from 'drizzle-orm'
import { createDb } from '@/server/db/client'
import { artifactRuns, artifacts, attachments, type ArtifactRunRow } from '@/server/db/schema'
import { disposeRpcStub } from '@/server/rpc'
import { IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'
import type { TaskNotificationPart } from '@/shared/parts'
import { assetRef } from '@/shared/asset-ref'

/**
 * What the Agent is told about a run it started. A failure keeps the provider's own words so it can
 * rephrase and retry. Outputs are named by `asset:` in the text and carried by id on the part, which
 * is what puts them in the set a later turn may reference (spec §2.2).
 */
export function toolRunNotification(
  run: Pick<ArtifactRunRow, 'id' | 'status' | 'error' | 'tool_call_id'>,
  outputs: ReadonlyArray<{ attachmentId: number, sha256: string }>,
): TaskNotificationPart {
  const base = {
    type: 'task_notification' as const, task_id: `image_run:${run.id}`,
    plugin_id: IMAGE_GENERATION_PLUGIN_ID, tool_call_id: run.tool_call_id ?? '',
  }
  if (run.status === 'completed') {
    const refs = outputs.map(output => assetRef(output.sha256))
    return {
      ...base, status: 'completed', text: `Generated ${outputs.length} image(s): ${refs.join(', ')}`,
      attachments: outputs.map(output => output.attachmentId),
    }
  }
  if (run.status === 'cancelled') return { ...base, status: 'cancelled', text: 'Cancelled by the user.' }
  return { ...base, status: 'failed', text: `Image generation failed: ${run.error ?? 'unknown error'}` }
}

/** Hands a settled tool run's outcome to its conversation. Anything but a settled tool run is left alone. */
export async function notifyToolRun(env: Env, userId: number, runId: number): Promise<void> {
  const db = createDb(env.DB)
  const run = await db.query.artifactRuns.findFirst({ where: and(eq(artifactRuns.id, runId), eq(artifactRuns.user_id, userId)) })
  if (!run || run.source !== 'tool' || run.conversation_id === null || run.message_id === null) return
  if (run.status !== 'completed' && run.status !== 'failed' && run.status !== 'cancelled') return
  const outputs = await db.select({ attachmentId: attachments.id, sha256: attachments.sha256 }).from(artifacts)
    .innerJoin(attachments, eq(attachments.id, artifacts.attachment_id))
    .where(and(eq(artifacts.run_id, run.id), eq(artifacts.user_id, userId), isNull(artifacts.deleted_at)))
    .orderBy(asc(artifacts.output_index))
  const hub = env.USER_HUB.getByName(String(userId))
  try {
    await hub.settleTask(userId, {
      conversation_id: run.conversation_id, origin_message_id: run.message_id, notification: toolRunNotification(run, outputs),
    })
  } finally {
    disposeRpcStub(hub)
  }
}
