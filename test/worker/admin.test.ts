import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { json, login, registerAndLogin, signupBody } from './auth-helper'

describe('minimal account administration', () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
  })

  // Removing the HTTP allowlist would restore dangerous built-in endpoints for uid 1.
  it.each([
    ['POST', 'remove-user', { userId: '2' }],
    ['POST', 'impersonate-user', { userId: '2' }],
    ['POST', 'update-user', { userId: '2', data: { email: 'replacement@example.com' } }],
    ['POST', 'update-user', { userId: '1', data: { name: 'Changed' } }],
    ['POST', 'set-email', { userId: '2', email: 'replacement@example.com' }],
    ['GET', 'get-user?id=2', undefined],
    ['POST', 'future-endpoint', {}],
  ] as const)('denies %s %s even for owner and administrators', async (method, endpoint, body) => {
    const owner = await registerAndLogin()
    await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
    const admin = await login({ ...signupBody, email: 'admin@example.com' })
    for (const client of [owner, admin]) expect((await client.json(method, `/api/auth/admin/${endpoint}`, body)).status).toBe(403)
    expect(await env.DB.prepare('SELECT email FROM users WHERE id = 2').first()).toEqual({ email: 'admin@example.com' })
  })

  it('denies ordinary users every administrative action', async () => {
    await registerAndLogin()
    const member = await registerAndLogin({ ...signupBody, email: 'member@example.com' })
    expect((await member.request('/api/admin/settings')).status).toBe(403)
    expect((await member.json('PUT', '/api/admin/settings', { allowRegister: null })).status).toBe(403)
    expect((await member.request('/api/auth/admin/list-users')).status).toBe(403)
    expect((await member.json('POST', '/api/model-catalog/refresh')).status).toBe(403)
    expect((await member.request('/api/model-catalog/refresh/catalog-manual-test')).status).toBe(403)
    for (const [endpoint, body] of [
      ['create-user', { ...signupBody, email: 'new@example.com' }],
      ['set-role', { userId: '2', role: 'admin' }], ['ban-user', { userId: '2' }],
      ['unban-user', { userId: '2' }], ['set-user-password', { userId: '2', newPassword: 'new-long-password' }],
      ['list-user-sessions', { userId: '2' }], ['revoke-user-sessions', { userId: '2' }],
      ['revoke-user-session', { sessionToken: 'unknown' }],
    ] as const) expect((await member.json('POST', `/api/auth/admin/${endpoint}`, body)).status).toBe(403)
  })

  it('manages account metadata, passwords and sessions with an ordinary admin', async () => {
    const owner = await registerAndLogin()
    await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
    const admin = await login({ ...signupBody, email: 'admin@example.com' })
    expect((await admin.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'member@example.com', role: 'user' })).status).toBe(200)
    const list = await (await admin.request('/api/auth/admin/list-users?limit=1&offset=2&sortBy=id&sortDirection=asc')).json() as { users: Record<string, unknown>[]; total: number }
    expect(list.total).toBe(3)
    expect(list.users).toHaveLength(1)
    expect(list.users[0]).toMatchObject({ email: 'member@example.com', role: 'user' })
    expect(Object.keys(list.users[0]!)).toEqual(expect.arrayContaining(['id', 'name', 'email', 'role', 'banned']))
    expect(Object.keys(list.users[0]!).every(key => ['id', 'name', 'email', 'emailVerified', 'image', 'createdAt', 'updatedAt', 'role', 'banned', 'banReason', 'banExpires'].includes(key))).toBe(true)
    expect((await admin.json('POST', '/api/auth/admin/set-role', { userId: '3', role: 'admin' })).status).toBe(200)
    expect((await admin.json('POST', '/api/auth/admin/ban-user', { userId: '3' })).status).toBe(200)
    expect((await admin.json('POST', '/api/auth/admin/unban-user', { userId: '3' })).status).toBe(200)
    expect((await admin.json('POST', '/api/auth/admin/set-user-password', { userId: '3', newPassword: 'new-long-password' })).status).toBe(200)
    const member = await login({ ...signupBody, email: 'member@example.com', password: 'new-long-password' })
    expect((await admin.json('POST', '/api/auth/admin/list-user-sessions', { userId: '3' })).status).toBe(200)
    expect((await admin.json('POST', '/api/auth/admin/revoke-user-sessions', { userId: '3' })).status).toBe(200)
    expect((await member.request('/api/me')).status).toBe(401)
  })

  it.each(['moderator', 'admin,user', ['admin', 'user'], []].map(role => ({ role })))('rejects non-singular roles $role', async ({ role }) => {
    const owner = await registerAndLogin()
    expect((await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'bad@example.com', role })).status).toBe(400)
    expect((await owner.json('POST', '/api/auth/admin/set-role', { userId: '1', role })).status).not.toBe(200)
  })

  it('rejects arbitrary create-user data and protects the owner', async () => {
    const owner = await registerAndLogin()
    expect((await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'new@example.com', data: { id: '1' } })).status).toBe(400)
    expect((await owner.json('POST', '/api/auth/admin/ban-user', { userId: '1' })).status).toBe(403)
    expect((await owner.json('POST', '/api/auth/admin/set-role', { userId: '1', role: 'user' })).status).toBe(403)
  })

  it('removes the persisted override when restoring deployment configuration', async () => {
    const owner = await registerAndLogin()
    expect((await owner.json('PUT', '/api/admin/settings', { allowRegister: false })).status).toBe(200)
    expect(await (await owner.json('PUT', '/api/admin/settings', { allowRegister: null })).json()).toEqual({ allowRegister: false, source: 'env' })
    expect(await env.DB.prepare("SELECT * FROM site_settings WHERE key = 'auth.allow_register'").first()).toBeNull()
    expect(await (await json('GET', '/api/site-config')).json()).toEqual({ allowRegister: false })
  })
})
