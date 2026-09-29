import { z } from 'zod'
import type { PluginConfigField, PluginConfigFieldType, PluginConfigStatus, PluginManifest } from '@/shared/plugins'

export interface PluginConfigControl {
  key: string
  label: string
  help: string
  type: PluginConfigFieldType
  placeholder?: string
  /** `select` only, taken from the schema's enum. */
  options: string[]
  min?: number
  max?: number
  default?: unknown
  /** Stored value folded in, falling back to the schema default. Always absent for a secret. */
  value?: unknown
  required: boolean
  /** `secret` only: whether a value is already stored. Its content never reaches the client. */
  configured: boolean
}

interface JsonSchemaProperty {
  enum?: unknown[]
  minimum?: number
  maximum?: number
  default?: unknown
}

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

/**
 * Options, bounds and defaults come from the schema, never from the field declaration: stating a
 * constraint twice is stating it until the two disagree. What the declaration owns is presentation
 * — the label, the help text, and which control to render.
 */
export function buildConfigControls(manifest: PluginManifest, status: PluginConfigStatus | undefined): PluginConfigControl[] {
  if (!manifest.configSchema) return []
  return controlsFrom(manifest.configSchema, manifest.config ?? [], status?.values ?? {}, status?.secrets ?? {})
}

/** The same form machinery over a plugin's per-conversation settings, which hold no secrets. */
export function buildConversationConfigControls(
  manifest: PluginManifest,
  values: Readonly<Record<string, unknown>> | undefined,
): PluginConfigControl[] {
  if (!manifest.conversationConfigSchema) return []
  return controlsFrom(manifest.conversationConfigSchema, manifest.conversationConfig ?? [], values ?? {}, {})
}

function controlsFrom(
  schema: z.ZodObject,
  fields: readonly PluginConfigField[],
  values: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, boolean>>,
): PluginConfigControl[] {
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonSchemaObject
  const required = new Set(json.required ?? [])
  return fields.map((field) => {
    const property = json.properties?.[field.key] ?? {}
    return {
      key: field.key,
      label: field.label,
      help: field.help,
      type: field.type,
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      options: (property.enum ?? []).filter((option): option is string => typeof option === 'string'),
      ...(property.minimum === undefined ? {} : { min: property.minimum }),
      ...(property.maximum === undefined ? {} : { max: property.maximum }),
      ...(property.default === undefined ? {} : { default: property.default }),
      ...(field.type === 'secret'
        ? {}
        : { value: values[field.key] ?? property.default ?? emptyValue(field.type) }),
      required: required.has(field.key),
      configured: secrets[field.key] === true,
    }
  })
}

function emptyValue(type: PluginConfigFieldType): unknown {
  if (type === 'boolean') return false
  if (type === 'key_value') return []
  return ''
}

/** A secret always starts blank: the form shows that one is stored, never what it is. */
export function initialFormValues(controls: readonly PluginConfigControl[]): Record<string, unknown> {
  return Object.fromEntries(controls.map(control => [
    control.key,
    control.type === 'secret' ? '' : control.value,
  ]))
}

/**
 * A blank secret means "leave it alone", not "clear it". The form always submits every visible
 * field, so sending the empty string would let someone editing a call budget silently destroy the
 * API key they never touched.
 */
export function buildConfigPatch(
  controls: readonly PluginConfigControl[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const control of controls) {
    const value = values[control.key]
    if (control.type === 'secret') {
      if (typeof value === 'string' && value.trim().length > 0) patch[control.key] = value.trim()
      continue
    }
    patch[control.key] = control.type === 'number' ? Number(value) : value
  }
  return patch
}
