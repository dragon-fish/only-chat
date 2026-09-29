import { z } from 'zod'

export { MCP_CALL_TOOL_TOOL_ID, MCP_LIST_SERVICES_TOOL_ID, MCP_LIST_TOOLS_TOOL_ID, MCP_PLUGIN_ID } from '@/shared/plugins'

/** How many tool names `mcp_list_services` shows per server; the rest are one `mcp_list_tools` away. */
export const MCP_TOOLS_PREVIEW = 10

const ServiceIdSchema = z.string().min(1).max(32).describe('The service_id from mcp_list_services')

export const McpListServicesInputSchema = z.strictObject({})

export const McpListToolsInputSchema = z.strictObject({
  service_id: ServiceIdSchema,
  query: z.string().max(500).optional()
    .describe('Comma-separated English keywords. Returns tools whose name, description or parameter names contain any of them. Omit to list every tool of the service.'),
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

export interface McpToolDetail {
  name: string
  description: string | null
  input_schema: unknown
}

export interface McpListToolsOutput {
  service_id: string
  name: string
  instructions?: string
  total: number
  tools: McpToolDetail[]
}

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

/**
 * The tools a query selects: any comma-separated keyword found, case-insensitively, in the tool's
 * name, its description or a top-level parameter name. An empty query selects everything.
 */
export function matchMcpTools<T extends { name: string, description?: string | null, inputSchema?: unknown }>(
  tools: readonly T[],
  query: string | undefined,
): T[] {
  const terms = (query ?? '').split(',').map(term => term.trim().toLowerCase()).filter(Boolean)
  if (terms.length === 0) return [...tools]
  return tools.filter((tool) => {
    const haystack = [tool.name, tool.description ?? '', ...parameterNames(tool.inputSchema)].join('\n').toLowerCase()
    return terms.some(term => haystack.includes(term))
  })
}

function parameterNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return []
  const properties = (schema as { properties?: unknown }).properties
  return properties && typeof properties === 'object' ? Object.keys(properties) : []
}
