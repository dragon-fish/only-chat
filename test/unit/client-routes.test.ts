// @vitest-environment happy-dom
import { createMemoryHistory, createRouter } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.restoreAllMocks())

describe('application route contracts', () => {
  it.each([{ desktop: true, entry: '/new' }, { desktop: false, entry: '/chats' }])('routes the root to $entry before rendering (desktop=$desktop)', async ({ desktop, entry }) => {
    const matchMedia = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation(query => {
      const media = matchMedia(query)
      Object.defineProperty(media, 'matches', { value: desktop })
      return media
    })
    const router = createRouter({ history: createMemoryHistory(), routes })
    await router.push('/')
    expect(router.currentRoute.value.path).toBe(entry)
    expect(router.resolve('/new').matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/new'])
    expect(router.resolve('/c/42').matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/c/:sessionId'])
  })

  it('keeps every Project page under its workspace parent without legacy aliases', () => {
    const router = createRouter({ history: createMemoryHistory(), routes })
    expect(router.resolve('/project/7').matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/project/:projectId', '/project/:projectId'])
    for (const [path, leaf] of [['settings', 'settings'], ['new', 'new'], ['c/42', 'c/:sessionId']]) {
      expect(router.resolve(`/project/7/${path}`).matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/project/:projectId', `/project/:projectId/${leaf}`])
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const path of ['/projects/7', '/settings/projects/7']) expect(router.resolve(path).matched).toHaveLength(0)
    warn.mockRestore()
  })
})
