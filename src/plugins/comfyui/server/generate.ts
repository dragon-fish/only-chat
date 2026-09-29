import type { Context } from 'cordis'
import { createBackendToolRun, findToolRun } from '@/server/plugins/artifacts/runs'
import type { ToolContext } from '@/server/plugins/tools'
import {
  COMFYUI_PROTOCOL, ComfyuiRunStateSchema,
  type ComfyuiConfig, type ComfyuiGenerateInput, type ComfyuiGenerateOutput, type ComfyuiRunState,
} from '../shared'
import { configuredDir, type ComfyuiClient } from './client'
import { loadTemplate, toolError } from './runners'
import { applyTemplate, parseApiWorkflow, summarizeTemplate, TemplateError, type ApiWorkflow } from './template'

/** Below 2^53 so it survives JSON and every sampler's seed range. */
function randomSeed(): number {
  const [high, low] = crypto.getRandomValues(new Uint32Array(2)) as unknown as [number, number]
  return (high & 0x1fffff) * 2 ** 32 + low
}

interface Prepared {
  workflow: ApiWorkflow
  template: string | null
  seed: number | null
  model: string
  prompt: string
  size: { width: number, height: number } | null
}

async function prepare(client: ComfyuiClient, config: ComfyuiConfig, input: ComfyuiGenerateInput): Promise<Prepared> {
  if (input.workflow !== undefined) {
    const workflow = parseApiWorkflow(input.workflow)
    const summary = summarizeTemplate('workflow', workflow)
    return { workflow, template: null, seed: null, model: summary.model, prompt: summary.prompt ?? '(API workflow)', size: summary.size }
  }
  const dir = configuredDir(config.workflows_dir)
  if (!dir) throw new TemplateError('No template directory is configured. Submit a complete workflow instead.')
  const seed = input.seed ?? randomSeed()
  const applied = applyTemplate(await loadTemplate(client, dir, input.template!), {
    prompt: input.prompt!, negative: input.negative, aspect_ratio: input.aspect_ratio, width: input.width, height: input.height,
    steps: input.steps, cfg: input.cfg, seed, loras: input.loras,
  })
  return { workflow: applied.workflow, template: input.template!, seed, model: applied.model, prompt: input.prompt!, size: applied.size }
}

/**
 * Submits synchronously so a workflow ComfyUI rejects comes straight back with its per-node report;
 * only the wait for the images runs in the background.
 */
export async function runGenerate(
  ctx: Context, toolCtx: ToolContext, client: ComfyuiClient, config: ComfyuiConfig,
  input: ComfyuiGenerateInput, toolCallId: string,
): Promise<ComfyuiGenerateOutput> {
  // A replayed call must not queue the same work on the GPU twice.
  const existing = await findToolRun(toolCtx.db, toolCtx.userId, toolCtx.assistantMessageId, toolCallId)
  if (existing) {
    const state = ComfyuiRunStateSchema.parse(existing.backend_state)
    return started(existing.id, state)
  }
  let prepared: Prepared
  let promptId: string
  try {
    prepared = await prepare(client, config, input)
    promptId = await client.submit(prepared.workflow)
  } catch (error) {
    return toolError(error)
  }
  const state: ComfyuiRunState = { prompt_id: promptId, template: prepared.template, seed: prepared.seed }
  const { run_id } = await createBackendToolRun(ctx, toolCtx.userId, {
    conversationId: toolCtx.conversationId, messageId: toolCtx.assistantMessageId, toolCallId,
    protocol: COMFYUI_PROTOCOL, sourceName: 'ComfyUI', modelId: prepared.template ?? 'workflow',
    modelName: prepared.model || (prepared.template ?? 'workflow'), prompt: prepared.prompt,
    params: { count: 1, size: prepared.size }, state,
  })
  return started(run_id, state)
}

function started(runId: number, state: ComfyuiRunState): ComfyuiGenerateOutput {
  return {
    task_id: `image_run:${runId}`, status: 'started', prompt_id: state.prompt_id,
    ...(state.template !== null ? { template: state.template } : {}),
    ...(state.seed !== null ? { seed: state.seed } : {}),
  }
}
