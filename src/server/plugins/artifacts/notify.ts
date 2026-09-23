import { and, asc, eq, isNull } from 'drizzle-orm'
import { createDb } from '@/server/db/client'
import { artifactRuns, artifacts, type ArtifactRow, type ArtifactRunRow } from '@/server/db/schema'
import { disposeRpcStub } from '@/server/rpc'
import { IMAGE_GENERATION_PLUGIN_ID } from '@/shared/plugins'
import type { TaskNotificationPart } from '@/shared/parts'

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** What the Agent is told about a run it started. A failure keeps the provider's own words so it can rephrase and retry. */
export function toolRunNotification(
  run: Pick<ArtifactRunRow, 'id' | 'status' | 'error' | 'tool_call_id'>,
  outputs: ReadonlyArray<Pick<ArtifactRow, 'id' | 'mime'>>,
): TaskNotificationPart {
  const base = {
    type: 'task_notification' as const, task_id: `image_run:${run.id}`,
    plugin_id: IMAGE_GENERATION_PLUGIN_ID, tool_call_id: run.tool_call_id ?? '',
  }
  if (run.status === 'completed') {
    const paths = outputs.map(output => `/artifacts/${output.id}.${EXTENSION[output.mime] ?? 'png'}`)
    return { ...base, status: 'completed', text: `Generated ${outputs.length} image(s): ${paths.join(', ')}` }
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
  const outputs = await db.select({ id: artifacts.id, mime: artifacts.mime }).from(artifacts)
    .where(and(eq(artifacts.run_id, run.id), isNull(artifacts.deleted_at))).orderBy(asc(artifacts.output_index))
  const hub = env.USER_HUB.getByName(String(userId))
  try {
    await hub.settleTask(userId, {
      conversation_id: run.conversation_id, origin_message_id: run.message_id, notification: toolRunNotification(run, outputs),
    })
  } finally {
    disposeRpcStub(hub)
  }
}
