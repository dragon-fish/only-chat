import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { attachments, conversations, models, providerInterfaces, providers } from '@/server/db/schema'
import { createConversation, insertMessage } from '@/server/plugins/hub/conversations'
import type { AuditConversationRow, AuditPage, AuditProviderRow, AuditTranscript } from '@/shared/api'
import type { Usage } from '@/shared/models'
import { login, registerAndLogin, signupBody } from './auth-helper'

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
})

const STORED_KEY = 'iv.stored-ciphertext-marker'
const OWNER = 1
const MEMBER = 3

async function setup(enableAudit: string | undefined) {
  const owner = await registerAndLogin()
  await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
  const admin = await login({ ...signupBody, email: 'admin@example.com' })
  const member = await registerAndLogin({ ...signupBody, name: 'Member', email: 'member@example.com' })
  const ctx = await createApp({ env: { ...env, ENABLE_AUDIT: enableAudit }, side: 'worker' })
  const db = ctx.db.orm

  const [provider] = await db.insert(providers).values({ user_id: MEMBER, name: 'Member gateway', api_key: STORED_KEY, created_at: 0 }).returning()
  const [endpoint] = await db.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://gateway.test/v1', created_at: 0 }).returning()
  await db.update(providers).set({ default_interface_id: endpoint!.id })
  await db.insert(providers).values({ user_id: OWNER, name: 'Owner gateway', created_at: 0 })
  await db.insert(models).values([
    { provider_id: provider!.id, model_id: 'on-model', metadata_resolved: { name: 'On model' }, enabled: true },
    { provider_id: provider!.id, model_id: 'off-model', enabled: false },
  ])

  const message = (conversationId: number, seq: number, role: 'user' | 'assistant', usage: Usage | null, modelId: string | null) =>
    insertMessage(db, MEMBER, {
      conversation_id: conversationId, parent_id: null, seq, role, parts: [{ type: 'text', text: `${role} ${seq}` }],
      provider_id: modelId ? provider!.id : null, model_id: modelId, usage, status: 'done', error: null, created_at: 0,
    })
  const chat = await createConversation(db, { user_id: MEMBER, title: 'Member chat', provider_id: null, model_id: null })
  await message(chat.id, 1, 'user', null, null)
  await message(chat.id, 2, 'assistant', { prompt: 10, completion: 3 }, 'off-model')
  await message(chat.id, 3, 'assistant', { prompt: 20, completion: 5 }, 'on-model')
  const archived = await createConversation(db, { user_id: MEMBER, title: 'Archived chat', provider_id: null, model_id: null })
  await db.update(conversations).set({ archived_at: 1 }).where(eq(conversations.id, archived.id))
  const ownerChat = await createConversation(db, { user_id: OWNER, title: 'Owner chat', provider_id: null, model_id: null })

  await ctx.assets.put('3/aa/member-image', new Uint8Array([1, 2, 3]).buffer, 'image/png')
  const [attachment] = await db.insert(attachments).values({ user_id: MEMBER, sha256: 'member-image', mime: 'image/png', size: 3, r2_key: '3/aa/member-image', origin: 'upload', created_at: 0 }).returning()

  const as = (client: { cookie: string }) => (path: string) => ctx.api.request(`/api${path}`, { headers: { cookie: client.cookie } })
  const paths = [
    '/admin/audit/conversations', `/admin/audit/conversations/${chat.id}`,
    '/admin/audit/providers', `/admin/audit/attachments/${attachment!.id}`,
  ]
  return { ctx, owner: as(owner), admin: as(admin), member: as(member), chat, archived, ownerChat, attachment: attachment!, paths }
}

const json = async <T>(response: Response | Promise<Response>) => await (await response).json() as T

describe('owner audit', () => {
  it.each([[undefined], ['false'], ['TRUE']])('is off unless ENABLE_AUDIT is exactly "true" (%s)', async value => {
    const { owner, paths } = await setup(value)
    expect(await json(owner('/admin/audit/status'))).toEqual({ enabled: false })
    for (const path of paths) expect.soft((await owner(path)).status, path).toBe(404)
  })

  it('refuses administrators and ordinary users', async () => {
    const { admin, member, paths } = await setup('true')
    for (const client of [admin, member]) {
      expect.soft((await client('/admin/audit/status')).status).toBe(403)
      for (const path of paths) expect.soft((await client(path)).status, path).toBe(403)
    }
  })

  it('lists every account providers without their credential', async () => {
    const { owner } = await setup('true')
    expect(await json(owner('/admin/audit/status'))).toEqual({ enabled: true })
    const text = await (await owner('/admin/audit/providers')).text()
    expect(text).not.toContain(STORED_KEY)
    expect(text).not.toContain('api_key')
    const page = JSON.parse(text) as AuditPage<AuditProviderRow>
    expect(page.rows.map(row => row.name)).toEqual(['Owner gateway', 'Member gateway'])
    const memberOnly = await json<AuditPage<AuditProviderRow>>(owner(`/admin/audit/providers?user=${MEMBER}`))
    expect(memberOnly.rows).toMatchObject([{
      name: 'Member gateway', has_key: true, owner: { id: MEMBER, name: 'Member' },
      interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }],
      models: [{ model_id: 'on-model', name: 'On model' }],
    }])
    expect(memberOnly.rows[0]!.models).toHaveLength(1)
    expect(memberOnly.rows[0]!.default_interface_id).toBe(memberOnly.rows[0]!.interfaces[0]!.id)
  })

  it('lists every account conversations with the model that ran and the tokens spent', async () => {
    const { owner, chat, archived, ownerChat } = await setup('true')
    const page = await json<AuditPage<AuditConversationRow>>(owner('/admin/audit/conversations'))
    expect(page.rows.map(row => row.id)).toEqual([ownerChat.id, archived.id, chat.id])
    expect(page.rows.find(row => row.id === chat.id)).toMatchObject({
      owner: { id: MEMBER, name: 'Member' }, archived: false,
      model: { model_id: 'on-model', name: 'On model' }, tokens: { input: 30, output: 8 },
    })
    expect(page.rows.find(row => row.id === archived.id)).toMatchObject({ archived: true, model: null, tokens: { input: 0, output: 0 } })
    expect((await json<AuditPage<AuditConversationRow>>(owner(`/admin/audit/conversations?user=${OWNER}`))).rows.map(row => row.id)).toEqual([ownerChat.id])
  })

  it('filters conversations by activity time', async () => {
    const { ctx, owner, chat, archived, ownerChat } = await setup('true')
    for (const [id, at] of [[chat.id, 1000], [archived.id, 2000], [ownerChat.id, 3000]]) {
      await ctx.db.orm.update(conversations).set({ updated_at: at }).where(eq(conversations.id, id!))
    }
    const ids = async (query: string) => (await json<AuditPage<AuditConversationRow>>(owner(`/admin/audit/conversations?${query}`))).rows.map(row => row.id)
    expect(await ids('since=2000&until=3000')).toEqual([archived.id])
    expect(await ids('sort=active&dir=asc')).toEqual([chat.id, archived.id, ownerChat.id])
  })

  // Bulk rows share one `updated_at`, so the `active` sort pages entirely on the id tiebreak.
  it.each(['sort=id', 'sort=active', 'sort=created&dir=asc'])('pages forward and back without gaps or repeats (%s)', async sort => {
    const { ctx, owner } = await setup('true')
    const now = Date.now()
    for (let i = 0; i < 60; i += 10) {
      await ctx.db.orm.insert(conversations).values(Array.from({ length: 10 }, (_, j) => ({
        user_id: MEMBER, title: `Bulk ${i + j}`, kind: 'chat' as const, created_at: now, updated_at: now,
      })))
    }
    const list = (query: string) => json<AuditPage<AuditConversationRow>>(owner(`/admin/audit/conversations?${sort}&${query}`))
    const all = (await list('limit=100')).rows.map(row => row.id)
    expect(all).toHaveLength(63)
    const first = await list('')
    expect(first.prev).toBeNull()
    const second = await list(`after=${first.next}`)
    expect([...first.rows, ...second.rows].map(row => row.id)).toEqual(all)
    expect(second.next).toBeNull()
    const back = await list(`before=${second.prev}`)
    expect(back.rows.map(row => row.id)).toEqual(first.rows.map(row => row.id))
    expect(back.prev).toBeNull()
  })

  // D1 binds at most 100 parameters, so a large page must not look its providers up in one IN list.
  it('serves a provider page larger than one statement can bind', async () => {
    const { ctx, owner } = await setup('true')
    for (let i = 0; i < 120; i += 10) {
      await ctx.db.orm.insert(providers).values(Array.from({ length: 10 }, (_, j) => ({ user_id: MEMBER, name: `Bulk ${i + j}`, created_at: 0 })))
    }
    const page = await json<AuditPage<AuditProviderRow>>(owner('/admin/audit/providers?limit=250'))
    expect(page.rows).toHaveLength(122)
    expect(page.rows.find(row => row.name === 'Member gateway')?.models).toHaveLength(1)
  })

  it.each([
    'limit=10', 'sort=title', 'dir=up', 'user=abc', 'after=1', 'after=1.1&before=2.2', 'since=-1',
  ])('rejects %s', async query => {
    const { owner } = await setup('true')
    expect((await owner(`/admin/audit/conversations?${query}`)).status).toBe(400)
  })

  it('reads any account transcript and attachment', async () => {
    const { owner, chat, attachment } = await setup('true')
    const transcript = await json<AuditTranscript>(owner(`/admin/audit/conversations/${chat.id}`))
    expect(transcript.conversation.id).toBe(chat.id)
    expect(transcript.owner).toMatchObject({ id: MEMBER, name: 'Member' })
    expect(transcript.messages).toHaveLength(3)
    const image = await owner(`/admin/audit/attachments/${attachment.id}`)
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect((await owner('/admin/audit/conversations/999999')).status).toBe(404)
  })
})
