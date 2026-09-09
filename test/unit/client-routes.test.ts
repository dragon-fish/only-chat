// @vitest-environment happy-dom
import { createMemoryHistory } from 'vue-router'
import { api, setUnauthorizedHandler } from '@/client/lib/api'
import { createAppRouter, redirectAfterUnauthorized } from '@/client/router'
import { useAuthStore } from '@/client/stores/auth'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  setUnauthorizedHandler(undefined)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function authenticatedRouter() {
  setActivePinia(createPinia())
  const auth = useAuthStore()
  auth.ready = true
  auth.authUser = { id: '1', email: 'owner@example.com', name: 'Owner' } as never
  return createAppRouter(createMemoryHistory())
}

describe('application route contracts', () => {
  it.each([{ desktop: true, entry: '/new' }, { desktop: false, entry: '/chats' }])('routes the root to $entry before rendering (desktop=$desktop)', async ({ desktop, entry }) => {
    const matchMedia = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation(query => {
      const media = matchMedia(query)
      Object.defineProperty(media, 'matches', { value: desktop })
      return media
    })
    const router = authenticatedRouter()
    await router.push('/')
    expect(router.currentRoute.value.path).toBe(entry)
    const draft = router.resolve('/new').matched.filter(route => route.components?.default)
    const chat = router.resolve('/c/42').matched.filter(route => route.components?.default)
    expect(draft.map(route => route.path)).toEqual(['/new/:conversationId?'])
    expect(chat.map(route => route.path)).toEqual(['/c/:conversationId?'])
    expect(chat[0]?.components?.default).toBe(draft[0]?.components?.default)
  })

  it('keeps every Project page under its workspace parent without legacy aliases', () => {
    const router = authenticatedRouter()
    expect(router.resolve('/project/7').matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/project/:projectId', '/project/:projectId'])
    for (const [path, leaf] of [['settings', 'settings'], ['new', 'new/:conversationId?'], ['c/42', 'c/:conversationId?']]) {
      expect(router.resolve(`/project/7/${path}`).matched.filter(route => route.components?.default).map(route => route.path)).toEqual(['/project/:projectId', `/project/:projectId/${leaf}`])
    }
    const draft = router.resolve('/project/7/new').matched.at(-1)
    const chat = router.resolve('/project/7/c/42').matched.at(-1)
    expect(chat?.components?.default).toBe(draft?.components?.default)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const path of ['/projects/7', '/settings/projects/7']) expect(router.resolve(path).matched).toHaveLength(0)
    warn.mockRestore()
  })


  // Removing requiresAuth or redirect preservation would lose the user's intended destination.
  it('redirects guests to login with the private destination preserved', async () => {
    setActivePinia(createPinia())
    const auth = useAuthStore()
    auth.ready = true
    const router = createAppRouter(createMemoryHistory())

    await router.push('/settings/providers')

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=%2Fsettings%2Fproviders')
    expect(router.resolve('/settings/providers').meta.requiresAuth).toBe(true)
    expect(router.resolve('/login').meta.guestOnly).toBe(true)
  })

  // Accepting an absolute or protocol-relative redirect would create an open redirect after login.
  it.each([
    'https://evil.test/steal',
    '//evil.test/steal',
    '/\\evil.test/steal',
  ])('ignores unsafe guest redirect %s', async redirect => {
    const router = authenticatedRouter()

    await router.push({ path: '/login', query: { redirect } })

    expect(router.currentRoute.value.fullPath).toBe('/new')
  })

  // Ignoring a valid relative redirect would discard context after an already-authenticated visit.
  it('sends authenticated visitors from guest pages to a safe preserved destination', async () => {
    const router = authenticatedRouter()

    await router.push('/login?redirect=%2Fsettings%2Fproviders')

    expect(router.currentRoute.value.fullPath).toBe('/settings/providers')
  })

  // Clearing state without navigating would leave expired-session content on screen.
  it('routes a 401 from a private page through the guest guard', async () => {
    const router = authenticatedRouter()
    await router.push('/settings/providers')
    setUnauthorizedHandler(() => redirectAfterUnauthorized(router))
    vi.stubGlobal('fetch', async () => Response.json({ error: 'Authentication required' }, { status: 401 }))

    await expect(api.conversations()).rejects.toMatchObject({ status: 401 })

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=%2Fsettings%2Fproviders')
    expect(useAuthStore().authUser).toBeNull()
  })
})
