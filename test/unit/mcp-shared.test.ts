import { describe, expect, it } from 'vitest'
import { mcpToolSummary, splitToolNames } from '@/plugins/mcp/shared'
import { isSensitiveHeaderName, mcpHeadersProblem } from '@/shared/mcp'

describe('MCP tool catalog helpers', () => {
  it('summarises a description as its first 160 characters on one line', () => {
    expect(mcpToolSummary('Search pages.\n\nUse   the fetch tool first.')).toBe('Search pages. Use the fetch tool first.')
    const long = mcpToolSummary('x'.repeat(400))
    expect(long).toHaveLength(161)
    expect(long?.endsWith('…')).toBe(true)
    expect(mcpToolSummary(null)).toBeNull()
  })

  it('splits tool names on commas, trimmed, keeping case and dropping blanks and repeats', () => {
    expect(splitToolNames(' search , Fetch,,search ')).toEqual(['search', 'Fetch'])
    expect(splitToolNames(' , ')).toEqual([])
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
