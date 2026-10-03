import { describe, expect, it } from 'vitest'
import { diffKnown, renderNotice } from '@/plugins/memory/server/notices'

const file = (path: string, version = 1, description: string | null = null) => ({ path, version, description })

describe('diffKnown', () => {
  it('tells a move from a delete and a create by the file it is', () => {
    const changes = diffKnown(
      { 1: file('/memory/user/topics/a.md'), 2: file('/memory/user/topics/gone.md'), 3: file('/memory/user/topics/same.md') },
      { 1: file('/memory/project/topics/a.md'), 3: file('/memory/user/topics/same.md'), 4: file('/memory/user/topics/new.md') },
    )
    expect(changes).toEqual({
      added: [file('/memory/user/topics/new.md')],
      updated: [],
      moved: [{ from: '/memory/user/topics/a.md', to: '/memory/project/topics/a.md' }],
      removed: ['/memory/user/topics/gone.md'],
    })
  })

  it('counts a new version or a new description as an update', () => {
    const changes = diffKnown(
      { 1: file('/memory/user/topics/a.md', 1, 'old'), 2: file('/memory/user/topics/b.md', 1, 'same') },
      { 1: file('/memory/user/topics/a.md', 1, 'new'), 2: file('/memory/user/topics/b.md', 2, 'same') },
    )
    expect(changes.updated.map(f => f.path)).toEqual(['/memory/user/topics/a.md', '/memory/user/topics/b.md'])
  })
})

describe('renderNotice', () => {
  it('lists each kind of change and carries a changed profile whole', () => {
    const text = renderNotice({
      added: [file('/memory/user/profile.md', 1, 'who')],
      updated: [file('/memory/user/topics/food.md', 2, 'tastes')],
      moved: [{ from: '/memory/user/a.md', to: '/memory/user/topics/a.md' }],
      removed: ['/memory/user/topics/old.md'],
    }, new Map([['/memory/user/profile.md', 'Engineer.\n']]))
    expect(text).toBe([
      'Memory changed since you last looked:',
      '- new /memory/user/profile.md — who',
      '<profile path="/memory/user/profile.md">\nEngineer.\n</profile>',
      '- updated /memory/user/topics/food.md — tastes',
      '- moved /memory/user/a.md → /memory/user/topics/a.md',
      '- removed /memory/user/topics/old.md',
    ].join('\n'))
  })
})
