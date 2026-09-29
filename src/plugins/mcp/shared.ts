import { z } from 'zod'

export { MCP_CALL_TOOL_TOOL_ID, MCP_LIST_SERVICES_TOOL_ID, MCP_LIST_TOOLS_TOOL_ID, MCP_PLUGIN_ID } from '@/shared/plugins'

/** How many tool names `mcp_list_services` shows per server; the rest are one `mcp_list_tools` away. */
export const MCP_TOOLS_PREVIEW = 10

const ServiceIdSchema = z.string().min(1).max(32).describe('The service_id from mcp_list_services')

export const McpListServicesInputSchema = z.strictObject({})

export const McpListToolsInputSchema = z.strictObject({
  service_id: ServiceIdSchema,
  tool_names: z.string().max(2000).optional()
    .describe('Comma-separated exact tool names from the catalog. Omit it for the catalog; pass it for those tools\' full definitions.'),
})
export type McpListToolsInput = z.infer<typeof McpListToolsInputSchema>

export const McpCallToolInputSchema = z.strictObject({
  service_id: ServiceIdSchema,
  tool_name: z.string().min(1).max(256).describe('The tool name exactly as mcp_list_tools gave it'),
  params: z.record(z.string(), z.unknown()).default({}).describe('Arguments matching the tool\'s input_schema'),
})
export type McpCallToolInput = z.infer<typeof McpCallToolInputSchema>

/** What `mcp_list_services` reports for one server. */
export interface McpServiceSummary {
  service_id: string
  name: string
  tool_count?: number
  tools_preview?: string[]
  error?: string
}

export interface McpListServicesOutput {
  services: McpServiceSummary[]
  message?: string
}

/** `mcp_list_tools` without names: every tool, named and summarised, with no schema. */
export interface McpToolCatalog {
  service_id: string
  name: string
  instructions?: string
  total: number
  tools: Array<{ name: string, summary: string | null }>
}

/** `mcp_list_tools` with names: only those tools, in full. */
export interface McpToolDefinitions {
  service_id: string
  name: string
  tools: Array<{ name: string, description: string | null, input_schema: unknown }>
  /** Names that matched no tool, so the model can go back to the catalog. */
  missing?: string[]
}

export type McpListToolsOutput = McpToolCatalog | McpToolDefinitions

/** Content the server returned that is neither text nor an image, described rather than dropped. */
export interface McpOtherContent {
  type: string
  [key: string]: unknown
}

export interface McpCallToolOutput {
  service_id: string
  tool_name: string
  is_error: boolean
  text: string
  text_truncated?: { original_length: number }
  images: Array<{ attachment_id: number, mime: string }>
  other: McpOtherContent[]
  structured?: unknown
}

export interface McpToolError {
  error: string
  message: string
}

const SUMMARY_LENGTH = 160

/** A description cut to its first 160 characters on one line: enough to choose by, never a schema's worth. */
export function mcpToolSummary(description: string | null | undefined): string | null {
  if (!description) return null
  const flat = description.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH)}…` : flat
}

/** Exact names only — a pattern would bring back the flood of full schemas the catalog exists to avoid. */
export function splitToolNames(value: string): string[] {
  return [...new Set(value.split(',').map(name => name.trim()).filter(Boolean))]
}
