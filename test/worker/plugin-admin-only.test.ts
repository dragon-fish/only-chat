import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { users } from '@/server/db/schema'
import { BROWSER_RUN_PLUGIN_ID, DATETIME_PLUGIN_ID } from '@/shared/plugins'
import { ensureTestUser, login, registerAndLogin } from './auth-helper'
import { connect } from './ws-helper'

const MEMBER = { name: 'member', email: 'member-admin-only@example.com', password: 'a-long-test-password' }

async function member() {
  await ensureTestUser()
  const db = createDb(env.DB)
  const existing = await db.query.users.findFirst({ where: eq(users.email, MEMBER.email) })
  const client = existing ? await login(MEMBER) : await registerAndLogin(MEMBER)
  const row = await db.query.users.findFirst({ where: eq(users.email, MEMBER.email) })
  return { client, id: row!.id }
}

async function mePlugins(client: { request(path: string): Promise<Response> }): Promise<Record<string, boolean>> {
  const body = await (await client.request('/api/me')).json() as { settings: { plugins: Record<string, boolean> } }
  return body.settings.plugins
}

describe('admin-only plugins', () => {
  it('stay on for an administrator', async () => {
    const owner = await ensureTestUser()
    const { ws, next } = await connect(owner)
    ws.send(JSON.stringify({ type: 'settings.update', settings: { plugins: { [BROWSER_RUN_PLUGIN_ID]: true } } }))
    const updated = await next('settings.updated') as { settings: { plugins: Record<string, boolean> } }
    expect(updated.settings.plugins[BROWSER_RUN_PLUGIN_ID]).toBe(true)
    expect((await mePlugins(owner))[BROWSER_RUN_PLUGIN_ID]).toBe(true)
  })

  it('cannot be switched on by anyone else, while ordinary plugins can', async () => {
    const { client } = await member()
    const { ws, next } = await connect(client)
    ws.send(JSON.stringify({ type: 'settings.update', settings: { plugins: { [BROWSER_RUN_PLUGIN_ID]: true, [DATETIME_PLUGIN_ID]: true } } }))
    const updated = await next('settings.updated') as { settings: { plugins: Record<string, boolean> } }
    expect(updated.settings.plugins[BROWSER_RUN_PLUGIN_ID]).toBeUndefined()
    expect(updated.settings.plugins[DATETIME_PLUGIN_ID]).toBe(true)
  })

  it('read as off for someone who had them on before losing the role', async () => {
    const { client, id } = await member()
    const db = createDb(env.DB)
    await db.update(users).set({ settings: { plugins: { [BROWSER_RUN_PLUGIN_ID]: true, [DATETIME_PLUGIN_ID]: true } } }).where(eq(users.id, id))
    const plugins = await mePlugins(client)
    expect(plugins[BROWSER_RUN_PLUGIN_ID]).toBeUndefined()
    expect(plugins[DATETIME_PLUGIN_ID]).toBe(true)
  })
})
