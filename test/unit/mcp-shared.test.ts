import { describe, expect, it } from 'vitest'
import { matchMcpTools } from '@/plugins/mcp/shared'
import { isSensitiveHeaderName, mcpHeadersProblem } from '@/shared/mcp'

const tools = [
  { name: 'search', description: 'Search the workspace', inputSchema: { properties: { query: {} } } },
  { name: 'retrieve_page', description: 'Fetch one page', inputSchema: { properties: { page_id: {} } } },
  { name: 'append_block_children', description: null, inputSchema: { properties: { block_id: {}, children: {} } } },
]

describe('matchMcpTools', () => {
  it('matches any comma-separated keyword in the name, description or a parameter name', () => {
    const names = (query?: string) => matchMcpTools(tools, query).map(tool => tool.name)
    expect(names('PAGE')).toEqual(['retrieve_page'])
    expect(names('workspace, block_id')).toEqual(['search', 'append_block_children'])
    expect(names('nothing')).toEqual([])
  })

  it('selects every tool when the query is absent or only separators', () => {
    expect(matchMcpTools(tools, undefined)).toHaveLength(3)
    expect(matchMcpTools(tools, ' , ')).toHaveLength(3)
  })
})

describe('MCP headers', () => {
  it('marks names that usually carry a credential as sensitive', () => {
    expect(['Authorization', 'X-API-Key', 'X-Auth-Token', 'Cookie'].every(isSensitiveHeaderName)).toBe(true)
    expect(['X-Region', 'Accept-Language'].some(isSensitiveHeaderName)).toBe(false)
  })

  it('refuses headers the transport sets, case-insensitive duplicates, and Authorization beside OAuth', () => {
    expect(mcpHeadersProblem([{ name: 'X-Region' }, { name: 'Authorization' }], { oauth: false })).toBeNull()
    expect(mcpHeadersProblem([{ name: 'content-type' }], { oauth: false })).not.toBeNull()
    expect(mcpHeadersProblem([{ name: 'X-Key' }, { name: 'x-key' }], { oauth: false })).not.toBeNull()
    expect(mcpHeadersProblem([{ name: 'Authorization' }], { oauth: true })).not.toBeNull()
    expect(mcpHeadersProblem([{ name: 'bad name' }], { oauth: false })).not.toBeNull()
  })
})
