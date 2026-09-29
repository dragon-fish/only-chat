import { z } from 'zod'

/** Output bounds for the read-only tools; anything longer is cut and says so. */
export const MAX_READ_BYTES = 256 * 1024
export const MAX_WORKFLOW_BYTES = 256 * 1024
export const MAX_MODEL_FILES = 500
export const MAX_NODE_CLASSES = 20
export const MAX_NODE_SEARCH_RESULTS = 50
export const MAX_COMBO_OPTIONS = 100
export const MAX_LORAS = 8

/** A userdata directory: relative segments of letters, digits, `_` and `-`, joined by `/`. */
const UserdataDirSchema = z.string().trim()
  .regex(/^$|^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/, '只能是 userdata 下的相对目录，如 api-workflows')
  .optional()

/**
 * Plain `https:` everywhere; plain `http:` to this machine only in development. Anything else would
 * send the Access headers in the clear.
 */
export function comfyuiUrlProblem(url: string, dev: boolean): string | null {
  let parsed: URL
  try { parsed = new URL(url) }
  catch { return '地址无效。' }
  if (parsed.protocol === 'https:') return null
  if (dev && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)) return null
  return '地址必须以 https:// 开头。'
}

export const COMFYUI_CONFIG_SCHEMA = z.object({
  base_url: z.string().trim().min(1, '请填写 ComfyUI 地址')
    .refine(url => comfyuiUrlProblem(url, import.meta.env.DEV) === null, '地址必须以 https:// 开头。'),
  cf_access_client_id: z.string().trim().optional(),
  cf_access_client_secret: z.string().trim().optional(),
  workflows_dir: UserdataDirSchema,
  guides_dir: UserdataDirSchema,
}).refine(
  config => Boolean(config.cf_access_client_id) === Boolean(config.cf_access_client_secret),
  { message: 'Client ID 与 Client Secret 需同时填写或同时留空', path: ['cf_access_client_secret'] },
)
export type ComfyuiConfig = z.infer<typeof COMFYUI_CONFIG_SCHEMA>

// ---- tool contracts

export const ASPECT_RATIO_NAMES = [
  'portrait', 'landscape', 'square',
  'large_portrait', 'large_landscape', 'large_square',
  'small_portrait', 'small_landscape', 'small_square',
] as const

export const ComfyuiListWorkflowsInputSchema = z.strictObject({})

export const ComfyuiReadInputSchema = z.strictObject({
  path: z.string().trim().min(1).max(300)
    .describe('A file under one of the directories comfyui_list_workflows reports, e.g. "api-workflows/anima.json" or "guides/anima.md".'),
})

export const ComfyuiListModelsInputSchema = z.strictObject({
  folder: z.string().trim().min(1).max(100).optional()
    .describe('A model folder such as checkpoints, diffusion_models, loras, vae, text_encoders. Omit to list the folders.'),
})

export const ComfyuiNodeInfoInputSchema = z.strictObject({
  class_types: z.array(z.string().trim().min(1).max(200)).min(1).max(MAX_NODE_CLASSES).optional()
    .describe('Exact node class names, e.g. ["KSampler", "LoraLoader"]. Returns each one\'s inputs, outputs and allowed values.'),
  search: z.string().trim().min(1).max(100).optional()
    .describe('A keyword matched against class names, display names and categories. Returns names only; look one up with class_types.'),
}).refine(input => input.class_types !== undefined || input.search !== undefined, 'Pass class_types, search, or both.')

const LoraSchema = z.strictObject({
  name: z.string().trim().min(1).max(300).describe('A file from comfyui_list_models("loras"), e.g. "detail.safetensors".'),
  strength_model: z.number().min(-10).max(10).optional(),
  strength_clip: z.number().min(-10).max(10).optional(),
})

const SizeSchema = z.number().int().min(256).max(4096).refine(value => value % 8 === 0, 'Must be a multiple of 8')

/** Template-mode fields; any of them next to `workflow` is rejected. */
const TEMPLATE_FIELDS = ['template', 'prompt', 'negative', 'aspect_ratio', 'width', 'height', 'steps', 'cfg', 'seed', 'loras'] as const

export const ComfyuiGenerateInputSchema = z.strictObject({
  template: z.string().trim().min(1).max(200).optional()
    .describe('Template mode: a template name from comfyui_list_workflows.'),
  prompt: z.string().trim().min(1).max(8000).optional()
    .describe('Template mode, required: the full positive prompt. Keep the template\'s own prompt as a prefix unless you mean to replace it.'),
  negative: z.string().trim().max(8000).optional()
    .describe('Template mode: the full negative prompt. Omit to keep the template\'s.'),
  aspect_ratio: z.enum(ASPECT_RATIO_NAMES).optional()
    .describe('Template mode: portrait 832x1216, landscape 1216x832, square 1024x1024; large_* about 1.5-2 MP; small_* for drafts. Omit for the template default.'),
  width: SizeSchema.optional().describe('Template mode: explicit width, with height. Overrides aspect_ratio.'),
  height: SizeSchema.optional().describe('Template mode: explicit height, with width.'),
  steps: z.number().int().min(1).max(200).optional(),
  cfg: z.number().min(0).max(100).optional(),
  seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Template mode: omit for a random seed.'),
  loras: z.array(LoraSchema).max(MAX_LORAS).optional()
    .describe('Template mode: LoRAs chained in this order, first closest to the model. The template\'s suggested LoRAs supply default strengths; any other file gets 1.'),
  workflow: z.record(z.string(), z.unknown()).optional()
    .describe('Raw mode: a complete ComfyUI API-format workflow, { "<node id>": { "class_type": ..., "inputs": {...} } }. Every other field must be omitted.'),
}).superRefine((input, ctx) => {
  if (input.workflow !== undefined) {
    const extra = TEMPLATE_FIELDS.filter(key => input[key] !== undefined)
    if (extra.length) ctx.addIssue({ code: 'custom', message: `Raw mode takes workflow only; remove ${extra.join(', ')}.` })
    if (JSON.stringify(input.workflow).length > MAX_WORKFLOW_BYTES) ctx.addIssue({ code: 'custom', message: `workflow exceeds ${MAX_WORKFLOW_BYTES} bytes.` })
    return
  }
  if (input.template === undefined) ctx.addIssue({ code: 'custom', message: 'Pass either template (with prompt) or workflow.' })
  if (input.prompt === undefined) ctx.addIssue({ code: 'custom', message: 'Template mode requires prompt.' })
  if ((input.width === undefined) !== (input.height === undefined)) ctx.addIssue({ code: 'custom', message: 'Pass width and height together.' })
})
export type ComfyuiGenerateInput = z.infer<typeof ComfyuiGenerateInputSchema>

export const ComfyuiErrorTypeSchema = z.enum(['network', 'auth', 'validation', 'comfyui_error', 'not_found', 'template'])
export type ComfyuiErrorType = z.infer<typeof ComfyuiErrorTypeSchema>

export const ComfyuiGenerateStartedSchema = z.object({
  task_id: z.string().regex(/^image_run:\d+$/),
  status: z.literal('started'),
  prompt_id: z.string(),
  template: z.string().optional(),
  seed: z.number().optional(),
})
export type ComfyuiGenerateStarted = z.infer<typeof ComfyuiGenerateStartedSchema>

export const ComfyuiToolErrorSchema = z.object({
  error: z.string(),
  error_type: ComfyuiErrorTypeSchema,
  /** ComfyUI's own per-node validation report, verbatim. */
  node_errors: z.record(z.string(), z.unknown()).optional(),
})
export type ComfyuiToolError = z.infer<typeof ComfyuiToolErrorSchema>

export type ComfyuiGenerateOutput = ComfyuiGenerateStarted | ComfyuiToolError

/** What a ComfyUI run keeps in `artifact_runs.backend_state`. */
export const ComfyuiRunStateSchema = z.object({
  prompt_id: z.string(),
  template: z.string().nullable(),
  seed: z.number().nullable(),
  duration_ms: z.number().optional(),
})
export type ComfyuiRunState = z.infer<typeof ComfyuiRunStateSchema>

export const COMFYUI_PROTOCOL = 'comfyui'
