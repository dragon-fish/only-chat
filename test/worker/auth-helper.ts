import { env, exports } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { createDb, type DB } from '@/server/db/client'
import { siteSettings, users } from '@/server/db/schema'

export const signupBody = { name: 'owner', email: 'owner@example.com', password: 'a-long-test-password' }
export type SignupInput = typeof signupBody

export const workerFetch = (path: string, init?: RequestInit) =>
  exports.default.fetch(new Request(`https://chat.test${path}`, init))

export const json = (method: string, path: string, body?: unknown, cookie?: string) => workerFetch(path, {
  method,
  headers: { 'content-type': 'application/json', origin: 'https://chat.test', ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export async function setAllowRegister(value: boolean) {
  await createDb(env.DB).insert(siteSettings).values({ key: 'auth.allow_register', value: String(value), updatedAt: new Date() })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: String(value), updatedAt: new Date() } })
}

function authenticatedClient(response: Response) {
  if (response.status !== 200) throw new Error(`Authentication failed: ${response.status}`)
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) throw new Error('Authentication returned no cookies')
  return {
    cookie,
    request(path: string, init?: RequestInit) {
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return workerFetch(path, { ...init, headers })
    },
    json: (method: string, path: string, body?: unknown) => json(method, path, body, cookie),
  }
}

export type AuthTestClient = ReturnType<typeof authenticatedClient>

export async function registerAndLogin(input: SignupInput = signupBody): Promise<AuthTestClient> {
  await setAllowRegister(true)
  return authenticatedClient(await json('POST', '/api/auth/sign-up/email', input))
}

export async function login(input: SignupInput = signupBody): Promise<AuthTestClient> {
  return authenticatedClient(await json('POST', '/api/auth/sign-in/email', input))
}

export async function ensureTestUser(db: DB = createDb(env.DB)): Promise<AuthTestClient> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, signupBody.email) })
  return existing ? login() : registerAndLogin()
}

export async function authenticatedFetch(request: Request): Promise<Response> {
  const client = await ensureTestUser()
  const headers = new Headers(request.headers)
  headers.set('cookie', client.cookie)
  return exports.default.fetch(new Request(request, { headers }))
}

export async function authenticatedRequest(app: import('@/server/plugins/api').ApiApp, path: string, init?: RequestInit) {
  const client = await ensureTestUser()
  const headers = new Headers(init?.headers)
  headers.set('cookie', client.cookie)
  return app.request(path, { ...init, headers })
}
