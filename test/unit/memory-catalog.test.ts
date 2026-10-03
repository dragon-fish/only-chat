import { describe, expect, it } from 'vitest'
import { CATALOG_LIMIT, renderCatalog, type CatalogEntry } from '@/plugins/memory/server/catalog'

const described = (name: string): CatalogEntry => ({ path: `/memory/user/${name}.md`, type: 'feedback', description: `about ${name}` })

describe('renderCatalog', () => {
  it('lists described and undescribed files, telling the model how to fix the latter', () => {
    const text = renderCatalog([described('style'), { path: '/memory/user/loose.md', type: null, description: null }], [])
    expect(text).toContain('- /memory/user/style.md (feedback) — about style')
    expect(text).toContain('- /memory/user/loose.md — undescribed: give it a type and description with memory_save')
    expect(text).toContain('<scope name="project">\n(empty)\n</scope>')
  })

  it('has no project scope at all outside a Project', () => {
    expect(renderCatalog([], null)).not.toContain('<scope name="project">')
    expect(renderCatalog([], null)).toContain('<scope name="user">\n(empty)\n</scope>')
  })

  it('stops at the limit and says how to see the rest', () => {
    const many = Array.from({ length: CATALOG_LIMIT + 3 }, (_, i) => described(`m${i}`))
    const text = renderCatalog(many, null)
    expect(text).toContain(`about m${CATALOG_LIMIT - 1}`)
    expect(text).not.toContain(`about m${CATALOG_LIMIT}\n`)
    expect(text).toContain('… and 3 more: list_files /memory/user')
  })
})
