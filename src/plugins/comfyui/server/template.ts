/**
 * ComfyUI API-format workflows used as templates: recognising the prompt, sampler, latent and LoRA
 * nodes by heuristics, and applying the model's overrides to a copy. Pure functions over parsed
 * JSON; the workflows themselves come from the user's ComfyUI userdata.
 */

import type { ASPECT_RATIO_NAMES } from '../shared'

export interface ApiNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type ApiWorkflow = Record<string, ApiNode>

type Link = [string, number]

export class TemplateError extends Error {
  override name = 'TemplateError'
}

export const ASPECT_RATIOS = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
  large_portrait: { width: 1024, height: 1536 },
  large_landscape: { width: 1536, height: 1024 },
  large_square: { width: 1472, height: 1472 },
  small_portrait: { width: 512, height: 768 },
  small_landscape: { width: 768, height: 512 },
  small_square: { width: 640, height: 640 },
} as const satisfies Record<typeof ASPECT_RATIO_NAMES[number], { width: number, height: number }>

export type AspectRatio = keyof typeof ASPECT_RATIOS

export interface TemplateLora {
  name: string
  strength_model: number
  strength_clip: number
}

/** What the model is told about a template. Snake case: it is serialised into a tool result. */
export interface TemplateSummary {
  name: string
  /** False when the prompt nodes cannot be identified; the workflow can still be submitted raw. */
  usable_as_template: boolean
  problem?: string
  model: string
  prompt?: string
  negative?: string
  defaults: Record<string, unknown>
  /** Null when the latent's width or height is fed by another node rather than a literal. */
  size: { width: number, height: number } | null
  /** The recommended pool: LoraLoader nodes the author left unconnected. */
  loras: TemplateLora[]
  /** True when the template rejects `loras`: a LoRA is already wired in, or the model/clip path cannot be traced. */
  lora_locked: boolean
}

export interface TemplateOverrides {
  prompt: string
  /** Omitted keeps the template's own negative text. */
  negative?: string
  aspect_ratio?: AspectRatio
  /** Must be given together with `height`; wins over `aspect_ratio`. */
  width?: number
  height?: number
  steps?: number
  cfg?: number
  seed: number
  /** Stack order: the first entry sits closest to the model loader. */
  loras?: Array<{ name: string, strength_model?: number, strength_clip?: number }>
}

export interface AppliedTemplate {
  workflow: ApiWorkflow
  size: { width: number, height: number } | null
  model: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLink(value: unknown): value is Link {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number')
    && typeof value[1] === 'number' && Number.isInteger(value[1])
}

function linkOf(value: unknown): Link | null {
  return isLink(value) ? [String(value[0]), value[1]] : null
}

export function parseApiWorkflow(value: unknown): ApiWorkflow {
  if (!isRecord(value)) throw new TemplateError('An API-format workflow must be a JSON object keyed by node id.')
  if (Array.isArray(value.nodes) || Array.isArray(value.links)) {
    throw new TemplateError('This is a UI-format workflow (it has nodes/links arrays). Export it from ComfyUI with Workflow → Export (API).')
  }
  const ids = Object.keys(value)
  if (ids.length === 0) throw new TemplateError('The workflow has no nodes.')
  for (const id of ids) {
    const node = value[id]
    if (!isRecord(node)) throw new TemplateError(`Node ${JSON.stringify(id)} is not an object.`)
    if (typeof node.class_type !== 'string' || !node.class_type) throw new TemplateError(`Node ${JSON.stringify(id)} has no class_type.`)
    if (!isRecord(node.inputs)) throw new TemplateError(`Node ${JSON.stringify(id)} has no inputs object.`)
  }
  return value as unknown as ApiWorkflow
}

/** Numeric ids in numeric order first, then the rest (subgraph ids such as "65:28") lexically. */
function sortedNodeIds(workflow: ApiWorkflow): string[] {
  const numeric = (id: string) => /^\d+$/.test(id)
  return Object.keys(workflow).sort((a, b) => {
    const an = numeric(a)
    const bn = numeric(b)
    if (an && bn) return Number(a) - Number(b)
    if (an) return -1
    if (bn) return 1
    return a < b ? -1 : a > b ? 1 : 0
  })
}

const LATENT_CLASSES = new Set(['EmptyLatentImage', 'EmptySD3LatentImage'])

function findSampler(workflow: ApiWorkflow): string | null {
  return sortedNodeIds(workflow).find(id => workflow[id]!.class_type.startsWith('KSampler')) ?? null
}

/** The latent the sampler actually consumes, else the first empty latent in the graph. */
function findLatent(workflow: ApiWorkflow, samplerId: string | null): string | null {
  const fed = samplerId === null ? null : linkOf(workflow[samplerId]!.inputs.latent_image)
  if (fed && LATENT_CLASSES.has(workflow[fed[0]]?.class_type ?? '')) return fed[0]
  return sortedNodeIds(workflow).find(id => LATENT_CLASSES.has(workflow[id]!.class_type)) ?? null
}

/** KSamplerAdvanced names its seed `noise_seed`; writing `seed` there would be silently ignored. */
function seedKey(sampler: ApiNode): string {
  return !('seed' in sampler.inputs) && 'noise_seed' in sampler.inputs ? 'noise_seed' : 'seed'
}

const POSITIVE_TITLE = ['positive', 'pos ', '正面', '正向']
const NEGATIVE_TITLE = ['negative', 'neg', '负面', '负向', '反向']
const NEGATIVE_TEXT = ['low quality', 'worst quality', 'bad anatomy', 'watermark', 'deformed', 'blurry', 'jpeg artifacts']

function isTextEncode(node: ApiNode | undefined): boolean {
  return node?.class_type === 'CLIPTextEncode'
}

function textOf(node: ApiNode): string {
  return typeof node.inputs.text === 'string' ? node.inputs.text : ''
}

/**
 * Positive and negative CLIPTextEncode ids, tried in order: the sampler's direct links, then
 * `_meta.title` keywords, then — with exactly two encoders — the one whose text reads like a
 * negative prompt.
 */
function findPromptNodes(workflow: ApiWorkflow, samplerId: string | null): { positive: string, negative: string | null } {
  if (samplerId === null) throw new TemplateError('No KSampler node, so the prompt nodes cannot be identified.')
  const sampler = workflow[samplerId]!
  const direct = (key: string) => {
    const link = linkOf(sampler.inputs[key])
    return link && isTextEncode(workflow[link[0]]) ? link[0] : null
  }
  const topoPositive = direct('positive')
  const topoNegative = direct('negative')
  if (topoPositive !== null) return { positive: topoPositive, negative: topoNegative }

  const encoders = sortedNodeIds(workflow).filter(id => isTextEncode(workflow[id]))
  let titledPositive: string | null = null
  let titledNegative: string | null = null
  for (const id of encoders) {
    const title = (workflow[id]!._meta?.title ?? '').toLowerCase()
    if (!title) continue
    if (NEGATIVE_TITLE.some(keyword => title.includes(keyword))) titledNegative ??= id
    else if (POSITIVE_TITLE.some(keyword => title.includes(keyword))) titledPositive ??= id
  }
  if (titledPositive !== null) return { positive: titledPositive, negative: titledNegative ?? topoNegative }

  if (encoders.length === 2) {
    const [a, b] = encoders as [string, string]
    const looksNegative = (id: string) => NEGATIVE_TEXT.some(hint => textOf(workflow[id]!).toLowerCase().includes(hint))
    if (looksNegative(a) && !looksNegative(b)) return { positive: b, negative: a }
    if (looksNegative(b) && !looksNegative(a)) return { positive: a, negative: b }
  }
  throw new TemplateError('Cannot tell which CLIPTextEncode is the positive prompt. Set _meta.title to "Positive Prompt" / "Negative Prompt" on the prompt nodes.')
}

const SAMPLER_DEFAULT_KEYS = ['steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']

const LOADER_INPUT_BY_CLASS: Record<string, string> = {
  UNETLoader: 'unet_name',
  UnetLoaderGGUF: 'unet_name',
  CheckpointLoaderSimple: 'ckpt_name',
  CheckpointLoader: 'ckpt_name',
  CLIPLoader: 'clip_name',
  CLIPLoaderGGUF: 'clip_name',
  DualCLIPLoader: 'clip_name1',
  VAELoader: 'vae_name',
}

function modelSummary(workflow: ApiWorkflow): string {
  const names: string[] = []
  for (const id of sortedNodeIds(workflow)) {
    const node = workflow[id]!
    const key = LOADER_INPUT_BY_CLASS[node.class_type]
    const value = key === undefined ? undefined : node.inputs[key]
    if (typeof value === 'string' && value) names.push(value)
  }
  return names.length ? names.join(' + ') : '(no loader nodes)'
}

function literalSize(workflow: ApiWorkflow, latentId: string | null): { width: number, height: number } | null {
  if (latentId === null) return null
  const { width, height } = workflow[latentId]!.inputs
  return typeof width === 'number' && typeof height === 'number' ? { width, height } : null
}

function isReferenced(workflow: ApiWorkflow, targetId: string): boolean {
  for (const [id, node] of Object.entries(workflow)) {
    if (id === targetId) continue
    for (const value of Object.values(node.inputs)) {
      if (linkOf(value)?.[0] === targetId) return true
    }
  }
  return false
}

interface PoolLora extends TemplateLora { nodeId: string }

function scanLoras(workflow: ApiWorkflow): { pool: PoolLora[], wired: string[] } {
  const pool: PoolLora[] = []
  const wired: string[] = []
  for (const id of sortedNodeIds(workflow)) {
    const node = workflow[id]!
    if (node.class_type !== 'LoraLoader') continue
    if (isReferenced(workflow, id)) {
      wired.push(id)
      continue
    }
    const { lora_name: name, strength_model: model, strength_clip: clip } = node.inputs
    if (typeof name !== 'string' || !name || typeof model !== 'number' || typeof clip !== 'number') continue
    pool.push({ nodeId: id, name, strength_model: model, strength_clip: clip })
  }
  return { pool: wired.length ? [] : pool, wired }
}

/** Follows a link upstream through any LoraLoader hops to the node that really provides it. */
function traceThroughLoras(workflow: ApiWorkflow, start: unknown, key: 'model' | 'clip'): Link | null {
  const seen = new Set<string>()
  let link = linkOf(start)
  while (link) {
    if (seen.has(link[0])) return null
    seen.add(link[0])
    const node = workflow[link[0]]
    if (!node) return null
    if (node.class_type !== 'LoraLoader') return link
    link = linkOf(node.inputs[key])
  }
  return null
}

interface Bindings {
  positive: string
  negative: string | null
  sampler: string
  latent: string | null
  pool: PoolLora[]
  /** Null when LoRAs cannot be attached; the string says why. */
  loraBlock: string | null
  modelSource: Link | null
  clipSource: Link | null
}

function bind(workflow: ApiWorkflow): Bindings {
  const sampler = findSampler(workflow)
  const { positive, negative } = findPromptNodes(workflow, sampler)
  const { pool, wired } = scanLoras(workflow)
  const modelSource = traceThroughLoras(workflow, workflow[sampler!]!.inputs.model, 'model')
  const clipSource = traceThroughLoras(workflow, workflow[positive]!.inputs.clip, 'clip')
  const loraBlock = wired.length
    ? `The template already wires LoraLoader node(s) ${wired.join(', ')} into its model path.`
    : modelSource === null || clipSource === null ? 'The model/clip path of this template cannot be traced.' : null
  return {
    positive, negative, sampler: sampler!, latent: findLatent(workflow, sampler),
    pool: loraBlock === null ? pool : [], loraBlock, modelSource, clipSource,
  }
}

export function summarizeTemplate(name: string, workflow: ApiWorkflow): TemplateSummary {
  const model = modelSummary(workflow)
  let bindings: Bindings
  try {
    bindings = bind(workflow)
  } catch (error) {
    if (!(error instanceof TemplateError)) throw error
    return {
      name, usable_as_template: false, problem: error.message, model,
      defaults: {}, size: null, loras: [], lora_locked: false,
    }
  }
  const sampler = workflow[bindings.sampler]!.inputs
  const defaults: Record<string, unknown> = {}
  for (const key of SAMPLER_DEFAULT_KEYS) {
    if (key in sampler && !isLink(sampler[key])) defaults[key] = sampler[key]
  }
  return {
    name, usable_as_template: true, model,
    prompt: textOf(workflow[bindings.positive]!),
    ...(bindings.negative === null ? {} : { negative: textOf(workflow[bindings.negative]!) }),
    defaults,
    size: literalSize(workflow, bindings.latent),
    loras: bindings.pool.map(({ name, strength_model, strength_clip }) => ({ name, strength_model, strength_clip })),
    lora_locked: bindings.loraBlock !== null,
  }
}

function requestedSize(overrides: TemplateOverrides): { width: number, height: number } | null {
  const { width, height } = overrides
  if ((width === undefined) !== (height === undefined)) throw new TemplateError('width and height must be given together.')
  if (width !== undefined && height !== undefined) return { width, height }
  return overrides.aspect_ratio === undefined ? null : { ...ASPECT_RATIOS[overrides.aspect_ratio] }
}

function freshNodeId(workflow: ApiWorkflow): string {
  let index = 1
  while (`comfyui_lora_${index}` in workflow) index++
  return `comfyui_lora_${index}`
}

/**
 * Chains the requested LoRAs between the model/clip providers and everything that consumed them.
 * A name from the pool reuses that dangling node and its authored strengths; any other name gets a
 * new LoraLoader, and ComfyUI's own validation reports a file that does not exist.
 */
function chainLoras(out: ApiWorkflow, bindings: Bindings, loras: NonNullable<TemplateOverrides['loras']>): void {
  if (bindings.loraBlock !== null) throw new TemplateError(`This template does not accept loras. ${bindings.loraBlock} Submit an edited workflow instead.`)
  const names = new Set<string>()
  for (const entry of loras) {
    if (names.has(entry.name)) throw new TemplateError(`LoRA ${JSON.stringify(entry.name)} is listed more than once.`)
    names.add(entry.name)
  }
  const modelSource = bindings.modelSource!
  const clipSource = bindings.clipSource!
  const pool = new Map(bindings.pool.map(lora => [lora.name, lora]))
  const chain: string[] = []
  for (const entry of loras) {
    const pooled = pool.get(entry.name)
    const id = pooled?.nodeId ?? freshNodeId(out)
    if (!pooled) out[id] = { class_type: 'LoraLoader', inputs: {}, _meta: { title: `LoRA ${entry.name}` } }
    const previous = chain.at(-1)
    Object.assign(out[id]!.inputs, {
      lora_name: entry.name,
      strength_model: entry.strength_model ?? pooled?.strength_model ?? 1,
      strength_clip: entry.strength_clip ?? pooled?.strength_clip ?? 1,
      model: previous === undefined ? [...modelSource] : [previous, 0],
      clip: previous === undefined ? [...clipSource] : [previous, 1],
    })
    chain.push(id)
  }
  const tail = chain.at(-1)!
  const inChain = new Set(chain)
  for (const [id, node] of Object.entries(out)) {
    if (inChain.has(id)) continue
    for (const [key, value] of Object.entries(node.inputs)) {
      const link = linkOf(value)
      if (!link) continue
      if (link[0] === modelSource[0] && link[1] === modelSource[1]) node.inputs[key] = [tail, 0]
      else if (link[0] === clipSource[0] && link[1] === clipSource[1]) node.inputs[key] = [tail, 1]
    }
  }
}

/**
 * A copy of the template with the overrides applied. An override always wins: when the input it
 * targets is fed by another node, the link is replaced by the literal and that node is left
 * dangling, which ComfyUI does not execute.
 */
export function applyTemplate(workflow: ApiWorkflow, overrides: TemplateOverrides): AppliedTemplate {
  const bindings = bind(workflow)
  const out = structuredClone(workflow)
  out[bindings.positive]!.inputs.text = overrides.prompt
  if (overrides.negative !== undefined) {
    if (bindings.negative === null) throw new TemplateError('This template has no negative prompt node.')
    out[bindings.negative]!.inputs.text = overrides.negative
  }
  const sampler = out[bindings.sampler]!
  sampler.inputs[seedKey(sampler)] = overrides.seed
  if (overrides.steps !== undefined) sampler.inputs.steps = overrides.steps
  if (overrides.cfg !== undefined) sampler.inputs.cfg = overrides.cfg
  const size = requestedSize(overrides)
  if (size) {
    if (bindings.latent === null) throw new TemplateError('This template has no EmptyLatentImage node, so its size cannot be set.')
    Object.assign(out[bindings.latent]!.inputs, size)
  }
  if (overrides.loras?.length) chainLoras(out, bindings, overrides.loras)
  return { workflow: out, size: literalSize(out, bindings.latent), model: modelSummary(workflow) }
}
