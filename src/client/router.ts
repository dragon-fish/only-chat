import { createRouter, createWebHistory, stringifyQuery, type RouteLocationNormalized, type RouteRecordRaw, type Router, type RouterHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'
import { useAuthStore } from '@/client/stores/auth'
import { isAuthAdmin, isAuthOwner } from '@/shared/auth'

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean
    guestOnly?: boolean
  }
}

function authRoute(route: RouteRecordRaw): RouteRecordRaw {
  const guestOnly = route.path === '/login' || route.path === '/register'
  return {
    ...route,
    meta: { ...route.meta, ...(guestOnly ? { guestOnly: true } : { requiresAuth: true }) },
    children: route.children?.map(authRoute),
  } as RouteRecordRaw
}

export function validatedRelativeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  const base = 'https://only-chat.local'
  try {
    const parsed = new URL(value, base)
    return parsed.origin === base ? `${parsed.pathname}${parsed.search}${parsed.hash}` : null
  } catch {
    return null
  }
}

function authenticatedDestination(to: RouteLocationNormalized, router: Router): string {
  const redirect = validatedRelativeRedirect(to.query.redirect)
  return redirect && !router.resolve(redirect).meta.guestOnly ? redirect : '/new'
}

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  const appRouter = createRouter({
    history,
    routes: routes.map(route => authRoute(route as RouteRecordRaw)),
    stringifyQuery: query => stringifyQuery(query).replaceAll('/', '%2F'),
  })
  appRouter.beforeEach(async to => {
    const auth = useAuthStore()
    if (!auth.ready) await auth.refresh()
    if (to.meta.requiresAuth && !auth.authUser) return { path: '/login', query: { redirect: to.fullPath } }
    if (to.path.startsWith('/admin') && !isAuthAdmin(auth.authUser)) return '/new'
    if (to.path.startsWith('/admin/audit') && !isAuthOwner(auth.authUser)) return '/new'
    if (to.meta.guestOnly && auth.authUser) return authenticatedDestination(to, appRouter)
  })
  return appRouter
}

export async function redirectAfterUnauthorized(appRouter: Router): Promise<void> {
  const current = appRouter.currentRoute.value
  if (current.meta.guestOnly) return
  await appRouter.replace({ path: '/login', query: { redirect: current.fullPath } })
}

export const router = createAppRouter()
