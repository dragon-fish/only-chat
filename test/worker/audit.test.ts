import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/server/app'
import { attachments, models, providerInterfaces, providers } from '@/server/db/schema'
import { createConversation, insertMessage } from '@/server/plugins/hub/conversations'
import type { AuditProvider, AuditTranscript } from '@/shared/api'
import { login, registerAndLogin, signupBody } from './auth-helper'

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
})

const STORED_KEY = 'iv.stored-ciphertext-marker'

async function setup(enableAudit: string | undefined) {
  const owner = await registerAndLogin()
  await owner.json('POST', '/api/auth/admin/create-user', { ...signupBody, email: 'admin@example.com', role: 'admin' })
  const admin = await login({ ...signupBody, email: 'admin@example.com' })
  const member = await registerAndLogin({ ...signupBody, email: 'member@example.com' })
  const memberId = 3
  const ctx = await createApp({ env: { ...env, ENABLE_AUDIT: enableAudit }, side: 'worker' })
  const db = ctx.db.orm

  const [provider] = await db.insert(providers).values({ user_id: memberId, name: 'Member gateway', api_key: STORED_KEY, created_at: 0 }).returning()
  const [endpoint] = await db.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://gateway.test/v1', created_at: 0 }).returning()
  await db.update(providers).set({ default_interface_id: endpoint!.id })
  await db.insert(models).values([
    { provider_id: provider!.id, model_id: 'on-model', metadata_resolved: { name: 'On model' }, enabled: true },
    { provider_id: provider!.id, model_id: 'off-model', enabled: false },
  ])
  const conversation = await createConversation(db, { user_id: memberId, title: 'Member chat', provider_id: provider!.id, model_id: 'on-model' })
  await insertMessage(db, memberId, { conversation_id: conversation.id, parent_id: null, seq: 1, role: 'user', parts: [{ type: 'text', text: 'hello' }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0 })
  const ownerConversation = await createConversation(db, { user_id: 1, title: 'Owner chat', provider_id: null, model_id: null })
  await ctx.assets.put('3/aa/member-image', new Uint8Array([1, 2, 3]).buffer, 'image/png')
  const [attachment] = await db.insert(attachments).values({ user_id: memberId, sha256: 'member-image', mime: 'image/png', size: 3, r2_key: '3/aa/member-image', origin: 'upload', created_at: 0 }).returning()
  const [ownerAttachment] = await db.insert(attachments).values({ user_id: 1, sha256: 'owner-image', mime: 'image/png', size: 3, r2_key: '1/aa/owner-image', origin: 'upload', created_at: 0 }).returning()

  const as = (client: { cookie: string }) => (path: string) => ctx.api.request(`/api${path}`, { headers: { cookie: client.cookie } })
  const paths = [
    `/admin/audit/users/${memberId}/providers`,
    `/admin/audit/users/${memberId}/conversations`,
    `/admin/audit/users/${memberId}/conversations/${conversation.id}/messages`,
    `/admin/audit/users/${memberId}/attachments/${attachment!.id}`,
  ]
  return { owner: as(owner), admin: as(admin), member: as(member), memberId, conversation, ownerConversation, attachment: attachment!, ownerAttachment: ownerAttachment!, paths }
}

describe('owner audit', () => {
  it.each([[undefined], ['false'], ['TRUE']])('is off unless ENABLE_AUDIT is exactly "true" (%s)', async value => {
    const { owner, paths } = await setup(value)
    expect(await (await owner('/admin/audit/status')).json()).toEqual({ enabled: false })
    for (const path of paths) expect.soft((await owner(path)).status, path).toBe(404)
  })

  it('refuses administrators and ordinary users', async () => {
    const { admin, member, paths } = await setup('true')
    for (const client of [admin, member]) {
      expect.soft((await client('/admin/audit/status')).status).toBe(403)
      for (const path of paths) expect.soft((await client(path)).status, path).toBe(403)
    }
  })

  it('shows the owner providers without their credential', async () => {
    const { owner, memberId } = await setup('true')
    expect(await (await owner('/admin/audit/status')).json()).toEqual({ enabled: true })
    const response = await owner(`/admin/audit/users/${memberId}/providers`)
    const text = await response.text()
    expect(text).not.toContain(STORED_KEY)
    expect(text).not.toContain('api_key')
    const [provider] = JSON.parse(text) as AuditProvider[]
    expect(provider).toMatchObject({
      name: 'Member gateway', has_key: true,
      interfaces: [{ protocol: 'responses', base_url: 'https://gateway.test/v1' }],
      models: [{ model_id: 'on-model', name: 'On model' }],
    })
    expect(provider!.models).toHaveLength(1)
    expect(provider!.default_interface_id).toBe(provider!.interfaces[0]!.id)
  })

  it('shows the owner conversations, messages and attachments of the named user only', async () => {
    const { owner, memberId, conversation, ownerConversation, attachment, ownerAttachment } = await setup('true')
    expect(await (await owner(`/admin/audit/users/${memberId}/conversations`)).json()).toMatchObject([{ id: conversation.id, title: 'Member chat' }])
    const transcript = await (await owner(`/admin/audit/users/${memberId}/conversations/${conversation.id}/messages`)).json() as AuditTranscript
    expect(transcript.conversation.id).toBe(conversation.id)
    expect(transcript.messages).toMatchObject([{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }])
    const image = await owner(`/admin/audit/users/${memberId}/attachments/${attachment.id}`)
    expect(image.status).toBe(200)
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    expect.soft((await owner(`/admin/audit/users/${memberId}/conversations/${ownerConversation.id}/messages`)).status).toBe(404)
    expect.soft((await owner(`/admin/audit/users/${memberId}/attachments/${ownerAttachment.id}`)).status).toBe(404)
    expect.soft((await owner('/admin/audit/users/abc/providers')).status).toBe(404)
  })
})
