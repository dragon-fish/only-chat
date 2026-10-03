import { describe, expect, it } from 'vitest'
import { CATALOG_LIMIT, INLINE_LIMIT, renderCatalog, type CatalogEntry } from '@/plugins/memory/server/catalog'
import { memoryCategory } from '@/plugins/memory/shared'

const topic = (name: string): CatalogEntry => ({ path: `/memory/user/topics/${name}.md`, category: 'topics', description: `about ${name}` })
const scope = (entries: CatalogEntry[], profile: string | null = null) => ({
  inline: profile === null ? [] : [{ category: 'profile' as const, path: '/memory/user/profile.md', text: profile }],
  entries,
})

describe('memoryCategory', () => {
  it('knows the two files and the three folders, and nothing else', () => {
    expect(memoryCategory('profile.md')).toBe('profile')
    expect(memoryCategory('preferences.md')).toBe('preferences')
    expect(memoryCategory('topics/饮食.md')).toBe('topics')
    expect(memoryCategory('areas/job-search.md')).toBe('areas')
    expect(memoryCategory('people/mom.md')).toBe('people')
    expect(memoryCategory('notes.md')).toBeNull()
    expect(memoryCategory('topics/food/sushi.md')).toBeNull()
    expect(memoryCategory('topics/food.txt')).toBeNull()
  })
})

describe('renderCatalog', () => {
  it('tells the model how to fix an undescribed file and one outside the layout', () => {
    const text = renderCatalog(scope([
      topic('food'),
      { path: '/memory/user/topics/loose.md', category: 'topics', description: null },
      { path: '/memory/user/stray.md', category: null, description: 'ignored' },
    ]), scope([]))
    expect(text).toContain('- /memory/user/topics/food.md — about food')
    expect(text).toContain('- /memory/user/topics/loose.md — undescribed: describe it with memory_save')
    expect(text).toContain('- /memory/user/stray.md — outside the memory layout: rename_file it to')
    expect(text).toContain('<scope name="project">\n(empty)\n</scope>')
  })

  it('has no project scope at all outside a Project', () => {
    expect(renderCatalog(scope([]), null)).not.toContain('<scope name="project">')
  })

  it('cuts an overlong single file and says how to get the rest', () => {
    const text = renderCatalog(scope([], 'x'.repeat(INLINE_LIMIT + 10)), null)
    expect(text).toContain(`${'x'.repeat(INLINE_LIMIT)}\n[Cut here: read_file the rest, and shorten the file.]`)
    expect(text).not.toContain('x'.repeat(INLINE_LIMIT + 1))
  })

  it('stops at the limit and says how to see the rest', () => {
    const many = Array.from({ length: CATALOG_LIMIT + 3 }, (_, i) => topic(`m${i}`))
    const text = renderCatalog(scope(many), null)
    expect(text).toContain(`about m${CATALOG_LIMIT - 1}`)
    expect(text).not.toContain(`about m${CATALOG_LIMIT}\n`)
    expect(text).toContain('… and 3 more: list_files /memory/user')
  })
})
