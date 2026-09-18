import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { createApp } from '@/server/app'
import { resolveAllowRegister } from '@/server/plugins/auth/site-settings'
import { registrationPolicy } from '@/server/plugins/auth/policy'
import { seedTestUser } from './user-fixture'
import { ensureTestUser, json, login, registerAndLogin, setAllowRegister, signupBody } from './auth-helper'

describe('registration policy and route protection', () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
  })

  it('does not log query parameters when an AuthSession database read fails', async () => {
    const client = await registerAndLogin()
    const ctx = await createApp({ env, side: 'worker' })
    const syntheticToken = 'synthetic-auth-token-must-never-be-logged'
    const logs = ['error', 'warn', 'log'] as const
    const captured: unknown[][] = []
    const spies = logs.map(level => vi.spyOn(console, level).mockImplementation((...args) => { captured.push(args) }))
    const failure = vi.spyOn(ctx.db.orm, 'select').mockImplementation(() => { throw new Error(`D1_ERROR: query params: ${syntheticToken}`) })
    try {
      const response = await ctx.auth.instance.handler(new Request('https://chat.test/api/auth/get-session', { headers: { cookie: client.cookie } }))
      expect(response.status).toBe(500)
      expect(captured.length).toBeGreaterThan(0)
      const output = captured.flat().map(value => value instanceof Error ? value.stack : String(value)).join('\n')
      expect(output).not.toContain(syntheticToken)
      expect(output).not.toContain('query params')
    } finally { failure.mockRestore(); spies.forEach(spy => spy.mockRestore()) }
  })

  it('rejects self-registration when registration is closed', async () => {
    expect((await json('POST', '/api/auth/sign-up/email', signupBody)).status).toBe(403)
    expect(await env.DB.prepare('SELECT id FROM users').first()).toBeNull()
  })

  it('makes the first registered user uid 1 when enabled', async () => {
    const client = await registerAndLogin()
    expect(await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(signupBody.email).first()).toEqual({ id: 1 })
    expect((await client.request('/api/conversations')).status).toBe(200)
    expect((await client.request('/api/admin/settings')).status).toBe(200)
  })

  it('does not claim an existing credential-less uid 1', async () => {
    await seedTestUser()
    await registerAndLogin({ ...signupBody, email: 'new@example.com' })
    expect(await env.DB.prepare("SELECT id FROM users WHERE email = 'new@example.com'").first()).toEqual({ id: 2 })
    expect(await env.DB.prepare('SELECT id FROM auth_accounts WHERE user_id = 1').first()).toBeNull()
  })

  it.each(['/api/me', '/api/conversations', '/api/providers', '/api/projects', '/api/models', '/api/attachments/1', '/api/model-catalog/status', '/api/admin/settings', '/ws'])('protects %s', async path => {
    expect((await json('GET', path)).status).toBe(401)
  })

  it('keeps health and public settings available without a session', async () => {
    expect((await json('GET', '/api/health')).status).toBe(200)
    expect(await (await json('GET', '/api/site-config')).json()).toEqual({ allowRegister: false })
  })

  it('allows administrators to change registration and create users while closed', async () => {
    const admin = await registerAndLogin()
    expect(await (await admin.json('PUT', '/api/admin/settings', { allowRegister: false })).json()).toEqual({ allowRegister: false, source: 'db' })
    expect((await json('POST', '/api/auth/sign-up/email', { ...signupBody, email: 'blocked@example.com' })).status).toBe(403)
    expect((await admin.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'invited@example.com', role: 'admin' })).status).toBe(200)
    const invited = await login({ ...signupBody, email: 'invited@example.com' })
    expect((await invited.request('/api/admin/settings')).status).toBe(200)
    expect((await (await login()).request('/api/me')).status).toBe(200)
  })

  it('denies regular users settings access and role spoofing', async () => {
    await registerAndLogin()
    const user = await registerAndLogin({ ...signupBody, email: 'user@example.com' })
    expect((await user.request('/api/admin/settings')).status).toBe(403)
    expect((await user.json('PUT', '/api/admin/settings', { allowRegister: false, role: 'admin', userId: '1' })).status).toBe(403)
    expect(await (await json('GET', '/api/site-config')).json()).toEqual({ allowRegister: true })
  })

  it.each([
    ['/api/auth/admin/ban-user', { userId: '1' }],
    ['/api/auth/admin/set-role', { userId: '1', role: 'user' }],
    ['/api/auth/admin/update-user', { userId: '1', data: { banned: true } }],
    ['/api/auth/admin/update-user', { userId: '1', data: { role: 'user' } }],
    ['/api/auth/admin/ban-user', { userId: '01' }],
    ['/api/auth/admin/set-role', { userId: '1.0', role: 'user' }],
    ['/api/auth/admin/update-user', { userId: '1', data: { banned: 1 } }],
    ['/api/auth/admin/ban-user', { userId: '1', data: null }],
    ['/api/auth/admin/ban-user', { userId: ['1'] }],
  ] as const)('protects uid 1 through %s', async (path, body) => {
    const owner = await registerAndLogin()
    await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
    const admin = await login({ ...signupBody, email: 'admin@example.com' })
    expect((await admin.json('POST', path, body)).status).toBe(403)
    expect(await env.DB.prepare('SELECT banned FROM users WHERE id = 1').first()).toEqual({ banned: 0 })
  })

  it('rejects invalid settings before persisting them', async () => {
    const admin = await registerAndLogin()
    expect((await admin.json('PUT', '/api/admin/settings', { allowRegister: 'true' })).status).toBe(400)
    await setAllowRegister(false)
    expect(await (await json('GET', '/api/site-config')).json()).toEqual({ allowRegister: false })
  })

  it.each([
    ['TRUE', true], ['False', false], ['invalid-secret-value', false], [true, true], [false, false],
  ] as const)('resolves the environment registration setting %s', async (value, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const db = createDb(env.DB)
      expect(await resolveAllowRegister(db, value)).toEqual({ value: expected, source: 'env' })
      if (value === 'invalid-secret-value') {
        expect(warn).toHaveBeenCalled()
        expect(JSON.stringify(warn.mock.calls)).not.toContain(value)
      }
      await setAllowRegister(!expected)
      expect(await resolveAllowRegister(db, value)).toEqual({ value: !expected, source: 'db' })
    } finally { warn.mockRestore() }
  })

  it('fails closed on corrupted database configuration', async () => {
    await setAllowRegister(true)
    await env.DB.exec("UPDATE site_settings SET value = 'garbage'")
    expect((await json('GET', '/api/site-config')).status).toBe(500)
    expect((await json('POST', '/api/auth/sign-up/email', signupBody)).status).toBe(403)
    expect(await env.DB.prepare('SELECT id FROM users').first()).toBeNull()
  })

  it('defaults to closed when no registration environment setting exists', async () => {
    expect(await resolveAllowRegister(createDb(env.DB), undefined)).toEqual({ value: false, source: 'default' })
  })

  it('gates future implicit creation but leaves existing provider sign-in and linking available', async () => {
    const policy = registrationPolicy(createDb(env.DB), 'false')
    for (const method of ['oauth', 'magic-link', 'email-otp', 'anonymous']) {
      expect(await policy({ user: {}, source: { action: 'create-user', method } })).toMatchObject({ error: 'registration_closed' })
    }
    for (const action of ['sign-in', 'link-account'] as const) {
      expect(await policy({ user: {}, source: { action, method: 'oauth' } })).toBeUndefined()
    }
    expect(await policy({ user: {}, source: { action: 'create-user', method: 'admin' } })).toBeUndefined()
  })

  it('rejects revoked and banned sessions at both API and WebSocket boundaries', async () => {
    const owner = await registerAndLogin()
    const user = await registerAndLogin({ ...signupBody, email: 'user@example.com' })
    expect((await owner.json('POST', '/api/auth/admin/ban-user', { userId: '2' })).status).toBe(200)
    expect((await user.request('/api/conversations')).status).toBe(401)
    expect((await user.request('/ws', { headers: { Upgrade: 'websocket' } })).status).toBe(401)
    expect((await json('POST', '/api/auth/sign-in/email', { ...signupBody, email: 'user@example.com' })).status).toBe(403)
    expect((await owner.json('POST', '/api/auth/sign-out', {})).status).toBe(200)
    expect((await owner.request('/api/me')).status).toBe(401)
  })

  it('rejects a retained session when the stored account becomes banned', async () => {
    await registerAndLogin()
    const user = await registerAndLogin({ ...signupBody, email: 'user@example.com' })
    await env.DB.exec('UPDATE users SET banned = 1 WHERE id = 2')
    expect(await env.DB.prepare('SELECT banned FROM users WHERE id = 2').first()).toEqual({ banned: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id = 2').first()).toEqual({ count: 1 })

    const api = await user.request('/api/conversations')
    const socket = await user.request('/ws', { headers: { Upgrade: 'websocket' } })
    if (socket.webSocket) {
      socket.webSocket.accept()
      socket.webSocket.close()
    }
    expect([api.status, socket.status]).toEqual([401, 401])
  })

  it('uses current stored permissions and allows normal owner profile updates', async () => {
    const owner = await registerAndLogin()
    expect((await owner.json('POST', '/api/auth/update-user', { name: 'Owner renamed' })).status).toBe(200)
    expect((await owner.json('POST', '/api/auth/admin/set-role', { userId: '1', role: 'admin' })).status).toBe(200)
    await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
    const admin = await login({ ...signupBody, email: 'admin@example.com' })
    expect((await admin.request('/api/admin/settings')).status).toBe(200)
    expect((await owner.json('POST', '/api/auth/admin/set-role', { userId: '2', role: 'user' })).status).toBe(200)
    expect((await admin.request('/api/admin/settings')).status).toBe(403)
  })
})

it('clears the browser cache on sign-out, because attachments outlive the session in it', async () => {
  const client = await ensureTestUser()
  const out = await client.json('POST', '/api/auth/sign-out', {})
  expect(out.status).toBe(200)
  // Attachments are cached by the browser for a year. Another account on this browser must not
  // inherit them, and the cache is the one store a page cannot clear from script.
  expect(out.headers.get('clear-site-data')).toBe('"cache"')
})
