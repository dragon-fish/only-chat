/** Loose readers for the read-only tools' results: stored results are shown as recorded, never trusted. */

export interface TemplateRow {
  name: string
  usable_as_template?: boolean
  problem?: string
  model?: string
  defaults?: Record<string, unknown>
  size?: { width: number, height: number } | null
  suggested_loras?: Array<{ name: string }>
}

export interface NodeInfo {
  class_type: string
  display_name?: string | null
  error?: string
  input?: Record<string, Record<string, unknown> | undefined>
  output?: string[]
}

/** One line of what a template generates with by default. */
export function describeTemplate(template: TemplateRow): string {
  const defaults = template.defaults ?? {}
  return [
    template.size ? `${template.size.width}×${template.size.height}` : null,
    typeof defaults.steps === 'number' ? `${defaults.steps} 步` : null,
    typeof defaults.cfg === 'number' ? `CFG ${defaults.cfg}` : null,
    typeof defaults.sampler_name === 'string' ? defaults.sampler_name : null,
  ].filter(Boolean).join(' · ')
}

/** A combo's type is its option list; the name `COMBO` says more than the first hundred options. */
export function inputsOf(node: NodeInfo): Array<{ name: string, type: string, optional: boolean }> {
  const out: Array<{ name: string, type: string, optional: boolean }> = []
  for (const [group, specs] of Object.entries(node.input ?? {})) {
    if (group !== 'required' && group !== 'optional') continue
    for (const [name, spec] of Object.entries(specs ?? {})) {
      const head = Array.isArray(spec) ? spec[0] : spec
      out.push({ name, type: Array.isArray(head) ? 'COMBO' : String(head), optional: group === 'optional' })
    }
  }
  return out
}

export function workflowNodes(workflow: object): Array<{ id: string, classType: string, title: string | null }> {
  return Object.entries(workflow as Record<string, { class_type?: unknown, _meta?: { title?: unknown } }>)
    .map(([id, node]) => ({
      id,
      classType: typeof node?.class_type === 'string' ? node.class_type : '?',
      title: typeof node?._meta?.title === 'string' ? node._meta.title : null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}
