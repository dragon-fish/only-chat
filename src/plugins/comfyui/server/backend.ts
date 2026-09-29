import type { Context } from 'cordis'
import type { ArtifactRunRow } from '@/server/db/schema'
import type { ImageBackendResult } from '@/server/plugins/artifacts/backends'
import { COMFYUI_PLUGIN_ID } from '@/shared/plugins'
import { COMFYUI_CONFIG_SCHEMA, COMFYUI_PROTOCOL, ComfyuiRunStateSchema } from '../shared'
import { ComfyuiClient, ComfyuiError } from './client'
import { readHistory } from './history'

const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 10 * 60_000
/** A poll that fails this many times in a row ends the run; fewer is a blip in the tunnel. */
const MAX_POLL_FAILURES = 5

const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

export interface PollTiming {
  intervalMs: number
  timeoutMs: number
}

export async function executeComfyuiRun(
  ctx: Context, userId: number, run: ArtifactRunRow, timing: PollTiming = { intervalMs: POLL_INTERVAL_MS, timeoutMs: POLL_TIMEOUT_MS },
): Promise<ImageBackendResult> {
  const state = ComfyuiRunStateSchema.parse(run.backend_state)
  const client = new ComfyuiClient(COMFYUI_CONFIG_SCHEMA.parse(await ctx.pluginConfig.read(userId, COMFYUI_PLUGIN_ID)))
  const deadline = Date.now() + timing.timeoutMs
  let failures = 0
  for (;;) {
    let outcome: ReturnType<typeof readHistory>
    try {
      outcome = readHistory(await client.history(state.prompt_id))
      failures = 0
    } catch (error) {
      if (!(error instanceof ComfyuiError) || ++failures >= MAX_POLL_FAILURES) throw error
      outcome = { state: 'pending' }
    }
    if (outcome.state === 'error') throw new Error(outcome.message)
    if (outcome.state === 'success') {
      if (!outcome.images.length) throw new Error('The workflow finished without producing any images. It needs an output node such as SaveImage.')
      const images = await Promise.all(outcome.images.map(async (image) => {
        const { bytes, mime } = await client.view(image)
        const extension = image.filename.split('.').pop()?.toLowerCase() ?? ''
        return { bytes, mime: mime.startsWith('image/') ? mime : MIME_BY_EXTENSION[extension] ?? mime }
      }))
      return { images, state: { ...state, ...(outcome.durationMs !== null ? { duration_ms: outcome.durationMs } : {}) } }
    }
    if (Date.now() >= deadline) throw new Error(`ComfyUI did not finish within ${Math.round(timing.timeoutMs / 60_000)} minutes (prompt ${state.prompt_id}).`)
    await new Promise(resolve => setTimeout(resolve, timing.intervalMs))
  }
}

export function comfyuiCompletedText(backendState: Record<string, unknown> | null, refs: readonly string[]): string {
  const parsed = ComfyuiRunStateSchema.safeParse(backendState)
  const details = parsed.success
    ? [
        parsed.data.seed !== null ? `seed ${parsed.data.seed}` : null,
        parsed.data.duration_ms !== undefined ? `${(parsed.data.duration_ms / 1000).toFixed(1)}s` : null,
        parsed.data.template !== null ? `template ${parsed.data.template}` : null,
      ].filter(Boolean)
    : []
  return `Generated ${refs.length} image(s): ${refs.join(', ')}${details.length ? ` (${details.join(', ')})` : ''}`
}

/**
 * Loaded wherever `imageBackends` is: the workflow side executes runs, the Worker side only needs
 * the notification attribution when a run is cancelled.
 */
export const ComfyuiBackendPlugin = {
  name: 'comfyui-backend',
  inject: ['imageBackends', 'pluginConfig'] as const,
  apply(ctx: Context) {
    ctx.imageBackends.register(COMFYUI_PROTOCOL, {
      pluginId: COMFYUI_PLUGIN_ID,
      execute: (userId, run) => executeComfyuiRun(ctx, userId, run),
      completedText: comfyuiCompletedText,
    })
  },
}
