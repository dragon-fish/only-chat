import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import { UserHub } from '@/server/index'
import { appendToolResult, compareAndSwapConversationHead, createConversation, deleteMessageIfUnreferenced, finalizeMessage, findReusableProviderFile, getMessage, getModel, getProviderInterface, insertAssistantChildIfAbsent, insertMessage, insertProviderFile, replaceMessagePartsIfCurrentHead, updateConversation } from '@/server/plugins/hub/conversations'
import { attachments, models, providerInterfaces, providers } from '@/server/db/schema'
import { persistGeneratedImage } from '@/server/plugins/hub/generated-images'
import { resolveAttachmentInputs } from '@/server/plugins/hub/attachment-transport'
import * as hubIdentity from '@/server/plugins/hub/identity'
import { DefaultGeneratedFile } from 'ai'
import { login, registerAndLogin, signupBody, workerFetch } from './auth-helper'
import { connect } from './ws-helper'

async function identity(client: Awaited<ReturnType<typeof registerAndLogin>>) {
  const result = await (await client.request('/api/auth/get-session')).json() as { user: { id: string }; session: { id: string } }
  return { userId: Number(result.user.id), authSessionId: result.session.id }
}

function closed(ws: WebSocket) {
  return new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), 1500)
    ws.addEventListener('close', event => { clearTimeout(timer); resolve(event) }, { once: true })
  })
}

describe('authenticated UserHub', () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
  })
  afterEach(async () => {
    for (const name of ['1', '2']) {
      await runInDurableObject(env.USER_HUB.getByName(name), (_instance: UserHub, state) => {
        for (const ws of state.getWebSockets()) ws.close(1000)
      })
    }
  })
  it('rejects an unauthenticated upgrade even with forged internal headers', async () => {
    const response = await workerFetch('/ws', { headers: { Upgrade: 'websocket', 'X-Only-Chat-User-Id': '1', 'X-Only-Chat-Auth-Session-Id': 'fake' } })
    expect(response.status).toBe(401)
  })

  it('routes by authenticated identity, overwrites forged headers, and isolates broadcasts', async () => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const a = await identity(alice)
    const b = await identity(bob)
    const aliceSocket = await connect(alice)
    const bobSocket = await connect({ cookie: bob.cookie, headers: { 'X-Only-Chat-User-Id': String(a.userId), 'X-Only-Chat-Auth-Session-Id': a.authSessionId } })
    await Promise.all([aliceSocket.next('snapshot'), bobSocket.next('snapshot')])
    bobSocket.ws.send(JSON.stringify({ type: 'project.create', name: 'Bob private' }))
    expect(await bobSocket.next('project.created')).toMatchObject({ project: { user_id: b.userId } })
    await runInDurableObject(env.USER_HUB.getByName(String(b.userId)), async (instance: UserHub, state) => {
      expect(await state.storage.get('identity:user-id')).toBe(b.userId)
      expect(instance.app.hub.userId).toBe(b.userId)
      expect(state.getWebSockets()[0]!.deserializeAttachment()).toEqual({ authSessionId: b.authSessionId })
    })
    expect(aliceSocket.events.map(event => event.type)).toEqual(['snapshot'])
  })

  it('rejects a mismatched persisted owner and reconstructs the Hub with the stored identity and sockets', async () => {
    const client = await registerAndLogin()
    const { userId, authSessionId } = await identity(client)
    const socket = await connect(client)
    const stub = env.USER_HUB.getByName(String(userId))
    const mismatch = await stub.fetch(new Request('https://hub/ws', { headers: { Upgrade: 'websocket', 'X-Only-Chat-User-Id': '2', 'X-Only-Chat-Auth-Session-Id': authSessionId } }))
    expect(mismatch.status).toBe(403)
    await runInDurableObject(stub, async (_instance: UserHub, state) => {
      const initialization: Promise<unknown>[] = []
      // Capture the constructor barrier while retaining the runtime's real storage and sockets.
      const block = state.blockConcurrencyWhile.bind(state)
      const capture = vi.spyOn(state, 'blockConcurrencyWhile').mockImplementation(callback => {
        const promise = block(callback)
        initialization.push(promise)
        return promise
      })
      const restored = new UserHub(state, env)
      capture.mockRestore()
      await Promise.all(initialization)
      expect(restored.app.hub.userId).toBe(userId)
      expect(await state.storage.get('identity:user-id')).toBe(userId)
      await restored.webSocketMessage(state.getWebSockets()[0]!, JSON.stringify({ type: 'project.create', name: 'after wake' }))
    })
    expect(await socket.next('project.created')).toMatchObject({ project: { user_id: userId, name: 'after wake' } })
  })

  it('keeps ownership inside atomic head, tool-result, continuation, and finalization writes', async () => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const aliceId = (await identity(alice)).userId
    const bobId = (await identity(bob)).userId
    const db = createDb(env.DB)
    const conversation = await createConversation(db, { user_id: bobId, title: 'private', provider_id: null, model_id: null })
    const message = await insertMessage(db, bobId, { conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', parts: [], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: 0 })
    await updateConversation(db, conversation.id, bobId, { head_message_id: message.id })
    const part = { type: 'tool_result' as const, call_id: 'ask', name: 'ask_user', content: { status: 'cancelled' } }
    expect(await compareAndSwapConversationHead(db, conversation.id, aliceId, message.id, message.id + 1)).toBeUndefined()
    expect(await appendToolResult(db, message.id, aliceId, conversation.id, part)).toBe(false)
    expect(await replaceMessagePartsIfCurrentHead(db, message, aliceId, [part])).toBe(false)
    expect(await insertAssistantChildIfAbsent(db, aliceId, { ...message, parent_id: message.id, role: 'assistant', seq: 2 })).toBeUndefined()
    await finalizeMessage(db, message.id, aliceId, { parts: [part], usage: null, status: 'aborted', error: 'stolen' })
    expect(await getMessage(db, message.id, aliceId)).toBeUndefined()
    expect(await getMessage(db, message.id, bobId)).toEqual(message)
    const shell = await insertMessage(db, bobId, { ...message, parent_id: message.id, seq: 2 })
    expect(await deleteMessageIfUnreferenced(db, shell.id, aliceId)).toBe(false)
    expect(await getMessage(db, shell.id, bobId)).toBeDefined()
    await expect(insertMessage(db, aliceId, { ...message, seq: 3 })).rejects.toThrow()
  })

  it('isolates generated-image deduplication, object keys, and attachment transport', async () => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const aliceId = (await identity(alice)).userId
    const bobId = (await identity(bob)).userId
    await Promise.all([connect(alice), connect(bob)])
    const bytes = new Uint8Array([137, 80, 78, 71, 50, 48, 50, 54])
    const generate = (userId: number) => runInDurableObject(env.USER_HUB.getByName(String(userId)), (instance: UserHub) => persistGeneratedImage(instance.app.hub, new DefaultGeneratedFile({ data: bytes, mediaType: 'image/png' })))
    const first = await generate(aliceId)
    const second = await generate(bobId)
    expect(first.attachment_id).not.toBe(second.attachment_id)
    expect(await generate(bobId)).toEqual(second)
    const rows = await env.DB.prepare('SELECT user_id, r2_key FROM attachments ORDER BY id').all<{ user_id: number; r2_key: string }>()
    expect(rows.results.map(row => [row.user_id, row.r2_key.split('/')[0]])).toEqual([[aliceId, String(aliceId)], [bobId, String(bobId)]])
    await runInDurableObject(env.USER_HUB.getByName(String(bobId)), async (instance: UserHub) => {
      const app = instance.app
      const provider = { id: 1, user_id: bobId, name: 'transport', api_key: null, enabled: true, created_at: 0, credential_version: 1, default_interface_id: null, models_dev_provider_id: null, models_dev_provider_source: null }
      const selected = { id: 1, provider_id: 1, protocol: 'responses' as const, base_url: 'https://example.com', native_files: false, created_at: 0 }
      await expect(resolveAttachmentInputs({ db: app.db.orm, userId: bobId, llm: app.llm, assets: app.assets }, provider, selected, [first.attachment_id])).rejects.toThrow(/attachment .* missing/)
      const owned = await resolveAttachmentInputs({ db: app.db.orm, userId: bobId, llm: app.llm, assets: app.assets }, provider, selected, [second.attachment_id])
      expect(owned.get(second.attachment_id)).toMatchObject({ mime: 'image/png', data: { type: 'data', data: bytes } })
    })
  })

  it('scopes model, interface, and remote attachment references to their owner', async () => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const aliceId = (await identity(alice)).userId
    const bobId = (await identity(bob)).userId
    const db = createDb(env.DB)
    const [provider] = await db.insert(providers).values({ user_id: bobId, name: 'private', created_at: 0 }).returning()
    const [selected] = await db.insert(providerInterfaces).values({ provider_id: provider!.id, protocol: 'responses', base_url: 'https://example.com', created_at: 0 }).returning()
    await db.insert(models).values({ provider_id: provider!.id, model_id: 'private-model', enabled: true })
    const [attachment] = await db.insert(attachments).values({ user_id: bobId, sha256: 'private-pointer', mime: 'image/png', size: 1, r2_key: 'private', origin: 'upload', created_at: 0 }).returning()
    const pointer = { provider_id: provider!.id, attachment_id: attachment!.id, base_url: 'https://example.com', file_family: 'openai' as const, provider_reference: { openai: 'secret-file' }, expires_at: 2000, created_at: 0 }
    await insertProviderFile(db, pointer, bobId)
    expect.soft(await getModel(db, provider!.id, 'private-model', aliceId)).toBeUndefined()
    expect.soft(await getProviderInterface(db, selected!.id, aliceId)).toBeUndefined()
    expect.soft(await findReusableProviderFile(db, { providerId: provider!.id, family: 'openai', baseURL: 'https://example.com', credentialVersion: 1 }, attachment!.id, 500, aliceId)).toBeUndefined()
    await expect(insertProviderFile(db, pointer, aliceId)).rejects.toThrow()
  })

  it('rejects cross-user conversation and tool mutations without changing the target', async () => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const { userId } = await identity(bob)
    const db = createDb(env.DB)
    const conversation = await createConversation(db, { user_id: userId, title: 'private', provider_id: null, model_id: null })
    const message = await insertMessage(db, userId, { conversation_id: conversation.id, parent_id: null, seq: 1, role: 'assistant', parts: [{ type: 'tool_call', id: 'ask', name: 'ask_user', args: { questions: [{ id: 'q', header: 'Q', question: 'Private?', type: 'text' }] } }], provider_id: null, model_id: null, usage: null, status: 'done', error: null, created_at: Date.now() })
    const socket = await connect(alice)
    const commands = [
      { type: 'conversation.delete', conversation_id: conversation.id },
      { type: 'conversation.update', conversation_id: conversation.id, title: 'stolen' },
      { type: 'conversation.fork', conversation_id: conversation.id, message_id: message.id },
      { type: 'switch_head', conversation_id: conversation.id, message_id: message.id },
      { type: 'tool.respond', message_id: message.id, call_id: 'ask', result: { status: 'cancelled', message: 'skip' } },
      { type: 'tool.continue', message_id: message.id },
    ]
    for (const [index, command] of commands.entries()) {
      socket.ws.send(JSON.stringify({ ...command, request_id: String(index) }))
      expect(await socket.nextAfter('error', index + 1)).toMatchObject({ request_id: String(index) })
    }
    expect(socket.events.filter(event => event.type === 'error').at(-1)).toMatchObject({ message: 'tool-call message not found' })
    expect(await env.DB.prepare('SELECT title, head_message_id FROM conversations WHERE id = ?').bind(conversation.id).first()).toEqual({ title: 'private', head_message_id: null })
    expect(await env.DB.prepare('SELECT parts FROM messages WHERE id = ?').bind(message.id).first()).toEqual({ parts: JSON.stringify(message.parts) })
  })

  it.each(['deleted', 'expired', 'wrong-owner', 'banned'] as const)('closes only the invalid socket when its AuthSession is %s', async reason => {
    const alice = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const a = await identity(alice)
    const b = await identity(bob)
    const socket = await connect(alice)
    const other = await connect(bob)
    await Promise.all([socket.next('snapshot'), other.next('snapshot')])
    if (reason === 'deleted') await env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind(a.authSessionId).run()
    if (reason === 'expired') await env.DB.prepare('UPDATE auth_sessions SET expires_at = 0 WHERE id = ?').bind(a.authSessionId).run()
    if (reason === 'wrong-owner') await env.DB.prepare('UPDATE auth_sessions SET user_id = ? WHERE id = ?').bind(b.userId, a.authSessionId).run()
    if (reason === 'banned') await env.DB.prepare('UPDATE users SET banned = 1 WHERE id = ?').bind(a.userId).run()
    const closing = closed(socket.ws)
    socket.ws.send(JSON.stringify({ type: 'project.create', name: 'blocked' }))
    expect((await closing).code).toBeGreaterThanOrEqual(4000)
    expect(await env.DB.prepare("SELECT id FROM projects WHERE name = 'blocked'").first()).toBeNull()
    other.ws.send(JSON.stringify({ type: 'project.create', name: 'still allowed' }))
    expect(await other.next('project.created')).toMatchObject({ project: { user_id: b.userId } })
    expect(other.events.filter(event => event.type === 'error')).toEqual([])
  })

  it('closes every banned user socket immediately after successful admin ban', async () => {
    const admin = await registerAndLogin()
    const bob = await registerAndLogin({ ...signupBody, email: 'bob@example.com' })
    const { userId } = await identity(bob)
    const first = await connect(bob)
    const second = await connect(bob)
    const closing = Promise.all([closed(first.ws), closed(second.ws)])
    expect((await admin.json('POST', '/api/auth/admin/ban-user', { userId: String(userId) })).status).toBe(200)
    expect((await closing).map(event => event.code)).toEqual([4001, 4001])
    expect((await workerFetch('/internal/auth-revoked', { method: 'POST' })).status).toBe(404)
  })

  it.each(['deleted', 'expired'] as const)('withholds private broadcasts from a silent %s AuthSession', async reason => {
    const first = await registerAndLogin()
    const second = await login()
    const { authSessionId } = await identity(first)
    const silent = await connect(first)
    const active = await connect(second)
    await Promise.all([silent.next('snapshot'), active.next('snapshot')])
    if (reason === 'deleted') await env.DB.prepare('DELETE FROM auth_sessions WHERE id = ?').bind(authSessionId).run()
    else await env.DB.prepare('UPDATE auth_sessions SET expires_at = 0 WHERE id = ?').bind(authSessionId).run()
    const closing = closed(silent.ws)
    active.ws.send(JSON.stringify({ type: 'project.create', name: 'Private after revocation' }))
    const [close, event] = await Promise.all([closing, active.next('project.created')])
    expect(close.code).toBe(4001)
    expect(event).toMatchObject({ project: { name: 'Private after revocation' } })
    expect(silent.events.map(event => event.type)).toEqual(['snapshot'])
  })

  it('aborts all in-flight jobs and waits for settlement before closing sockets', async () => {
    const client = await registerAndLogin()
    const { userId } = await identity(client)
    const socket = await connect(client)
    await socket.next('snapshot')
    const closing = closed(socket.ws)
    await runInDurableObject(env.USER_HUB.getByName(String(userId)), async (instance: UserHub) => {
      const hub = instance.app.hub
      const message = { id: 7001, conversation_id: 100, parent_id: null, seq: 1, role: 'assistant' as const, parts: [], provider_id: null, model_id: null, usage: null, status: 'streaming' as const, error: null, created_at: 0 }
      const first = { message, conversationId: 100, controller: new AbortController(), startedAt: Date.now(), parts: [] }
      const second = { ...first, message: { ...message, id: 7002, conversation_id: 101 }, conversationId: 101, controller: new AbortController() }
      await hub.trackInflight(first)
      await hub.trackInflight(second)
      let settled = false
      const revoking = hub.revokeAccess().then(() => { settled = true })
      expect([first.controller.signal.aborted, second.controller.signal.aborted]).toEqual([true, true])
      await expect(hub.trackInflight({ ...first, message: { ...message, id: 7003 } })).rejects.toThrow('Authentication revoked')
      await hub.untrackInflight(first.message.id)
      expect(settled).toBe(false)
      await hub.untrackInflight(second.message.id)
      await revoking
      expect(hub.inflight()).toEqual([])
    })
    expect((await closing).code).toBe(4001)
  })

  it('rejects an upgrade when revocation races its AuthSession validation', async () => {
    const client = await registerAndLogin()
    const { userId, authSessionId } = await identity(client)
    await connect(client)
    await runInDurableObject(env.USER_HUB.getByName(String(userId)), async (instance: UserHub) => {
      const validate = hubIdentity.hasActiveAuthSession
      const raced = vi.spyOn(hubIdentity, 'hasActiveAuthSession').mockImplementationOnce(async (...args) => {
        const active = await validate(...args)
        await instance.app.hub.revokeAccess()
        return active
      })
      try {
        const response = await instance.fetch(new Request('https://hub/ws', { headers: { Upgrade: 'websocket', 'X-Only-Chat-User-Id': String(userId), 'X-Only-Chat-Auth-Session-Id': authSessionId } }))
        if (response.webSocket) { response.webSocket.accept(); response.webSocket.close() }
        expect(response.status).toBe(401)
      } finally { raced.mockRestore() }
    })
  })
})
