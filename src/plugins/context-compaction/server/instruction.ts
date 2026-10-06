/**
 * The request that asks for the summary (spec §3.5). The template is the person's
 * `service_prompts.compaction`, or `SERVICE_PROMPT_DEFAULTS.compaction`; it is used whole, with
 * `{date}` filled in. What only some requests need is appended here rather than templated.
 */

export interface InstructionOptions {
  template: string
  /** Today, as YYYY-MM-DD. */
  date: string
  /** What the person asked the summary to keep above all, for a manual compaction. */
  focus: string | null
  /** The retry after a reply that called a tool. */
  strict?: boolean
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export function summaryInstruction({ template, date, focus, strict = false }: InstructionOptions): string {
  const lines = [template.replaceAll('{date}', date)]
  if (strict) {
    lines.push('', 'IMPORTANT: Your previous reply called a tool. Tools are unavailable for this request. Reply with plain text only — the summary and nothing else.')
  }
  if (focus && focus.trim()) {
    lines.push('', 'The user asked this summary to focus on the following. Center the summary on it:', focus.trim())
  }
  return lines.join('\n')
}
