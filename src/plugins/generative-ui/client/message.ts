import type { ActionEvent } from '@openuidev/vue-lang'

/** Form state stores each field as `{ value, componentType }`; $variables are stored bare. */
function fieldValue(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'value' in raw ? (raw as { value: unknown }).value : raw
}

function isFieldRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !('value' in raw)
}

function readable(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value)) return value.length > 0 ? value.map(item => String(item)).join(', ') : null
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** `key: value` pairs from a form's state, or from the whole store when the button sits outside one. */
function collect(state: Record<string, unknown> | undefined, formName: string | undefined): [string, string][] {
  if (!state) return []
  const scope = formName && isFieldRecord(state[formName]) ? state[formName] as Record<string, unknown> : state
  const pairs: [string, string][] = []
  for (const [key, raw] of Object.entries(scope)) {
    if (isFieldRecord(raw)) {
      for (const [inner, innerRaw] of Object.entries(raw)) {
        const value = readable(fieldValue(innerRaw))
        if (value !== null) pairs.push([inner, value])
      }
      continue
    }
    const value = readable(fieldValue(raw))
    if (value !== null) pairs.push([key.replace(/^\$/, ''), value])
  }
  return pairs
}

/** The user message a "continue the conversation" click turns into. */
export function messageFromAction(event: ActionEvent): string {
  const lines = [event.humanFriendlyMessage.trim()]
  const context = event.params.context
  if (typeof context === 'string' && context.trim()) lines.push(context.trim())
  const pairs = collect(event.formState, event.formName)
  if (pairs.length > 0) lines.push('', ...pairs.map(([key, value]) => `- ${key}: ${value}`))
  return lines.join('\n').trim()
}
