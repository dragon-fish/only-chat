import {
  MAX_COMBO_OPTIONS, MAX_MODEL_FILES, MAX_NODE_SEARCH_RESULTS, MAX_READ_BYTES,
  type ComfyuiConfig, type ComfyuiToolError,
} from '../shared'
import { ComfyuiError, configuredDir, type ComfyuiClient } from './client'
import { parseApiWorkflow, summarizeTemplate, TemplateError, type ApiWorkflow, type TemplateSummary } from './template'

const MAX_TEMPLATES = 50

export function toolError(error: unknown): ComfyuiToolError {
  if (error instanceof ComfyuiError) {
    return { error: error.message, error_type: error.type, ...(error.nodeErrors ? { node_errors: error.nodeErrors } : {}) }
  }
  if (error instanceof TemplateError) return { error: error.message, error_type: 'template' }
  throw error
}

function templateNameOf(file: string): string {
  return file.replace(/\.json$/i, '')
}

/** Reads and parses one template; a missing file, bad JSON or GUI format is a `TemplateError`. */
export async function loadTemplate(client: ComfyuiClient, dir: string, name: string): Promise<ApiWorkflow> {
  let text: string
  try {
    text = await client.readUserdata(`${dir}/${name}.json`)
  } catch (error) {
    if (error instanceof ComfyuiError && error.type === 'not_found') throw new TemplateError(`No template named "${name}". Call comfyui_list_workflows for the list.`)
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new TemplateError(`Template "${name}" is not valid JSON.`) }
  return parseApiWorkflow(value)
}

type ListedTemplate = TemplateSummary & { path: string }

export async function runListWorkflows(client: ComfyuiClient, config: ComfyuiConfig) {
  const workflowsDir = configuredDir(config.workflows_dir)
  const guidesDir = configuredDir(config.guides_dir)
  if (!workflowsDir && !guidesDir) {
    return {
      templates: [], guides: [],
      note: 'No template or guide directory is configured. Build a workflow with comfyui_list_models and comfyui_node_info, then submit it with comfyui_generate({ workflow }).',
    }
  }
  const templates: ListedTemplate[] = []
  let note: string | undefined
  if (workflowsDir) {
    const files = (await client.listUserdata(workflowsDir)).filter(file => /\.json$/i.test(file))
    if (files.length > MAX_TEMPLATES) note = `Showing ${MAX_TEMPLATES} of ${files.length} templates.`
    templates.push(...await Promise.all(files.slice(0, MAX_TEMPLATES).map(async (file): Promise<ListedTemplate> => {
      const name = templateNameOf(file)
      const path = `${workflowsDir}/${file}`
      try {
        return { ...summarizeTemplate(name, await loadTemplate(client, workflowsDir, name)), path }
      } catch (error) {
        if (!(error instanceof TemplateError)) throw error
        return { name, path, usable_as_template: false, problem: error.message, model: '', defaults: {}, size: null, loras: [], lora_locked: true }
      }
    })))
  }
  const guides = guidesDir
    ? (await client.listUserdata(guidesDir)).filter(file => /\.md$/i.test(file)).map(file => `${guidesDir}/${file}`)
    : []
  return { templates, guides, ...(note ? { note } : {}) }
}

export async function runRead(client: ComfyuiClient, config: ComfyuiConfig, path: string) {
  const workflowsDir = configuredDir(config.workflows_dir)
  const guidesDir = configuredDir(config.guides_dir)
  const inside = (dir: string | null) => dir !== null && path.startsWith(`${dir}/`) && !path.split('/').includes('..')
  if (!inside(workflowsDir) && !inside(guidesDir)) {
    const allowed = [workflowsDir, guidesDir].filter(Boolean).map(dir => `${dir}/`)
    return {
      error: allowed.length ? `Only files under ${allowed.join(' or ')} can be read.` : 'No template or guide directory is configured.',
      error_type: 'not_found' as const,
    }
  }
  const text = await client.readUserdata(path)
  if (inside(workflowsDir) && /\.json$/i.test(path)) {
    if (text.length > MAX_READ_BYTES) return { error: `${path} is larger than ${MAX_READ_BYTES} bytes.`, error_type: 'template' as const }
    let value: unknown
    try { value = JSON.parse(text) }
    catch { return { error: `${path} is not valid JSON.`, error_type: 'template' as const } }
    return { path, workflow: parseApiWorkflow(value) }
  }
  return text.length > MAX_READ_BYTES
    ? { path, content: text.slice(0, MAX_READ_BYTES), note: `Truncated at ${MAX_READ_BYTES} of ${text.length} characters.` }
    : { path, content: text }
}

export async function runListModels(client: ComfyuiClient, folder: string | undefined) {
  if (folder === undefined) return { folders: await client.modelFolders() }
  const files = await client.models(folder)
  return files.length > MAX_MODEL_FILES
    ? { folder, files: files.slice(0, MAX_MODEL_FILES), note: `Showing ${MAX_MODEL_FILES} of ${files.length} files.` }
    : { folder, files }
}

/**
 * Caps every option list in a node definition. Both spellings occur: a legacy combo is
 * `[[...options], {...}]`, a newer one is `['COMBO', { options: [...] }]`.
 */
export function compactNodeInfo(info: Record<string, unknown>): Record<string, unknown> {
  const capInput = (spec: unknown): unknown => {
    if (!Array.isArray(spec)) return spec
    const [type, options, ...rest] = spec as [unknown, unknown, ...unknown[]]
    const capList = (list: unknown[]) => list.length > MAX_COMBO_OPTIONS
      ? [...list.slice(0, MAX_COMBO_OPTIONS), `… ${list.length - MAX_COMBO_OPTIONS} more`]
      : list
    const cappedType = Array.isArray(type) ? capList(type) : type
    const cappedOptions = options && typeof options === 'object' && Array.isArray((options as { options?: unknown }).options)
      ? { ...options, options: capList((options as { options: unknown[] }).options) }
      : options
    return spec.length === 1 ? [cappedType] : [cappedType, cappedOptions, ...rest]
  }
  const input = info.input as Record<string, Record<string, unknown> | undefined> | undefined
  if (!input) return info
  const cappedInput: Record<string, unknown> = {}
  for (const [group, specs] of Object.entries(input)) {
    cappedInput[group] = specs && typeof specs === 'object'
      ? Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, capInput(spec)]))
      : specs
  }
  return { ...info, input: cappedInput }
}

export async function runNodeInfo(client: ComfyuiClient, classTypes: readonly string[] | undefined, search: string | undefined) {
  const out: Record<string, unknown> = {}
  if (classTypes) {
    out.nodes = await Promise.all(classTypes.map(async (classType) => {
      try {
        const info = (await client.objectInfo(classType))[classType]
        return info ? { class_type: classType, ...compactNodeInfo(info) } : { class_type: classType, error: 'Unknown node class.' }
      } catch (error) {
        if (error instanceof ComfyuiError && error.type === 'not_found') return { class_type: classType, error: 'Unknown node class.' }
        throw error
      }
    }))
  }
  if (search) {
    const keyword = search.toLowerCase()
    const matches = Object.entries(await client.objectInfo())
      .filter(([name, info]) => [name, info.display_name, info.category].some(value => typeof value === 'string' && value.toLowerCase().includes(keyword)))
      .map(([name, info]) => ({ name, display_name: info.display_name, category: info.category }))
    out.matches = matches.slice(0, MAX_NODE_SEARCH_RESULTS)
    if (matches.length > MAX_NODE_SEARCH_RESULTS) out.note = `Showing ${MAX_NODE_SEARCH_RESULTS} of ${matches.length} matches; narrow the keyword.`
  }
  return out
}
