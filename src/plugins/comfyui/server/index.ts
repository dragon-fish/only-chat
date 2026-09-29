import type { Context } from 'cordis'
import { tool } from 'ai'
import type { ToolContext } from '@/server/plugins/tools'
import {
  COMFYUI_GENERATE_TOOL_ID, COMFYUI_LIST_MODELS_TOOL_ID, COMFYUI_LIST_WORKFLOWS_TOOL_ID, COMFYUI_NODE_INFO_TOOL_ID,
  COMFYUI_PLUGIN_ID, COMFYUI_READ_TOOL_ID,
} from '@/shared/plugins'
import {
  COMFYUI_CONFIG_SCHEMA, ComfyuiGenerateInputSchema, ComfyuiListModelsInputSchema, ComfyuiListWorkflowsInputSchema, ComfyuiNodeInfoInputSchema,
  ComfyuiReadInputSchema, type ComfyuiConfig,
} from '../shared'
import { ComfyuiClient } from './client'
import { runGenerate } from './generate'
import { runListModels, runListWorkflows, runNodeInfo, runRead, toolError } from './runners'

function configOf(toolCtx: ToolContext): ComfyuiConfig {
  return COMFYUI_CONFIG_SCHEMA.parse(toolCtx.config)
}

/** A ComfyUI failure becomes a result the model can act on; anything else is a bug and propagates. */
async function guarded<T>(run: () => Promise<T>) {
  try { return await run() }
  catch (error) { return toolError(error) }
}

const LIST_WORKFLOWS_DESCRIPTION = [
  'Lists the ComfyUI workflow templates and prompting guides the user keeps on their ComfyUI server.',
  'Each template reports its model, its own positive and negative prompt, default sampler settings and size, and suggested_loras (unconnected LoRA nodes, applied only when named). A template with usable_as_template false can still be read with comfyui_read and submitted as a raw workflow.',
  'Before writing a prompt for a model family, read its guide with comfyui_read when one is listed: models differ in prompt style (tags versus prose).',
].join('\n')

const READ_DESCRIPTION = 'Reads one file listed by comfyui_list_workflows: a template\'s full API-format workflow (to adapt and submit in raw mode) or a guide\'s markdown.'

const LIST_MODELS_DESCRIPTION = 'Lists the model folders on the ComfyUI server, or the files in one folder (checkpoints, diffusion_models, loras, vae, text_encoders, ...). Use the exact file names in workflows and LoRA lists.'

const NODE_INFO_DESCRIPTION = [
  'Looks up ComfyUI node classes: pass class_types for their inputs (with types, defaults and allowed values) and outputs, or search to find class names by keyword.',
  'Use it to build or adapt a raw workflow. Do not guess input names; look them up.',
].join('\n')

const GENERATE_DESCRIPTION = [
  'Generates images on the user\'s ComfyUI server in the background. Two modes, never mixed:',
  '- Template mode: template + prompt, optionally negative, aspect_ratio or width/height, steps, cfg, seed and loras. The template supplies everything else.',
  '- Raw mode: workflow, a complete API-format graph { "<node id>": { "class_type", "inputs" } } with at least one output node such as SaveImage. Links are [source node id, output index]. You set the seed yourself; ComfyUI returns a cached result without generating when the graph is identical to an earlier one.',
  'The workflow is validated on submission. A rejected one returns error_type "validation" with node_errors naming each node and input at fault; fix those and submit again.',
  'An accepted one returns a task_id at once. The images arrive later as a <task-notification> message listing them as asset: references; do not wait, poll, or submit again for the same request. Tell the user it is on its way, or continue with other work.',
].join('\n')

export const ComfyuiServerPlugin = {
  name: 'comfyui',
  inject: ['tools', 'db', 'env'] as const,
  apply(ctx: Context) {
    ctx.tools.register(COMFYUI_PLUGIN_ID, COMFYUI_LIST_WORKFLOWS_TOOL_ID, toolCtx => tool({
      description: LIST_WORKFLOWS_DESCRIPTION,
      inputSchema: ComfyuiListWorkflowsInputSchema,
      execute: async () => guarded(() => {
        const config = configOf(toolCtx)
        return runListWorkflows(new ComfyuiClient(config), config)
      }),
    }))
    ctx.tools.register(COMFYUI_PLUGIN_ID, COMFYUI_READ_TOOL_ID, toolCtx => tool({
      description: READ_DESCRIPTION,
      inputSchema: ComfyuiReadInputSchema,
      execute: async ({ path }) => guarded(() => {
        const config = configOf(toolCtx)
        return runRead(new ComfyuiClient(config), config, path)
      }),
    }))
    ctx.tools.register(COMFYUI_PLUGIN_ID, COMFYUI_LIST_MODELS_TOOL_ID, toolCtx => tool({
      description: LIST_MODELS_DESCRIPTION,
      inputSchema: ComfyuiListModelsInputSchema,
      execute: async ({ folder }) => guarded(() => runListModels(new ComfyuiClient(configOf(toolCtx)), folder)),
    }))
    ctx.tools.register(COMFYUI_PLUGIN_ID, COMFYUI_NODE_INFO_TOOL_ID, toolCtx => tool({
      description: NODE_INFO_DESCRIPTION,
      inputSchema: ComfyuiNodeInfoInputSchema,
      execute: async ({ class_types, search }) => guarded(() => runNodeInfo(new ComfyuiClient(configOf(toolCtx)), class_types, search)),
    }))
    ctx.tools.register(COMFYUI_PLUGIN_ID, COMFYUI_GENERATE_TOOL_ID, toolCtx => tool({
      description: GENERATE_DESCRIPTION,
      inputSchema: ComfyuiGenerateInputSchema,
      execute: async (input, { toolCallId }) => {
        const config = configOf(toolCtx)
        return runGenerate(ctx, toolCtx, new ComfyuiClient(config), config, input, toolCallId)
      },
    }))
  },
}
