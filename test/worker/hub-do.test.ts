import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { createDb } from '@/server/db/client'
import type { UserHub } from '@/server/index'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession } from '@/server/plugins/hub/sessions'
import type { Message } from '@/shared/models'
import { connect } from './ws-helper'
import { CodexOAuthFlowStore } from '@/server/plugins/codex/flow'

describe('UserHub DO', () => {
  it('resumes encrypted OAuth flow storage and exposes only internal completion IDs over RPC', async () => {
    const stub = env.USER_HUB.getByName('oauth-rpc-test')
    const flowId = crypto.randomUUID()
    await runInDurableObject(stub, async (_instance: UserHub, state) => {
      const flows = new CodexOAuthFlowStore(state.storage, env.KEY_ENCRYPTION_SECRET)
      await flows.create({ flowId, deviceAuthId: 'rpc-device', userCode: 'rpc-code', verificationUrl: 'https://auth.openai.com/codex/device', intervalMs: 5000, nextPollAt: 0, expiresAt: Date.now() + 60_000 })
      expect(await new CodexOAuthFlowStore(state.storage, env.KEY_ENCRYPTION_SECRET).read(flowId, Date.now())).toMatchObject({ flowId, userCode: 'rpc-code' })
    })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url
      if (url.endsWith('/deviceauth/token')) return Response.json({ authorization_code: 'rpc-auth', code_verifier: 'rpc-verifier', code_challenge: 'rpc-challenge' })
      if (url.endsWith('/oauth/token')) return Response.json({
        id_token: `header.${btoa(JSON.stringify({ email: 'rpc@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: crypto.randomUUID() } }))}.signature`,
        access_token: 'rpc-access', refresh_token: 'rpc-refresh', token_type: 'Bearer', expires_in: 3600,
      })
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'rpc-model' }] })
      throw new Error('Unexpected request')
    })
    try {
      const result = await stub.pollCodexOAuth(flowId)
      expect(result).toEqual({ status: 'complete', providerId: expect.any(Number), modelIds: ['rpc-model'], modelListError: null })
      await runInDurableObject(stub, async (_instance: UserHub, state) => {
        expect(await state.storage.get(`codex-oauth:${flowId}`)).toBeUndefined()
      })
    } finally { vi.unstubAllGlobals() }
  })

  it('sends a snapshot on connect and rejects non-upgrade requests', async () => {
    const plain = await exports.default.fetch(new Request('https://x/ws'))
    expect(plain.status).toBe(426)
    const { next } = await connect()
    const snap = await next('snapshot')
    expect(snap).toEqual({ type: 'snapshot', inflight: [] })
  })

  it('rejects a websocket upgrade whose Origin does not match the request host', async () => {
    const res = await exports.default.fetch(new Request('https://x/ws', { headers: { Upgrade: 'websocket', Origin: 'https://evil.example' } }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'origin not allowed' })
  })

  it('accepts a websocket upgrade whose Origin matches the request host', async () => {
    const res = await exports.default.fetch(new Request('https://x/ws', { headers: { Upgrade: 'websocket', Origin: 'https://x' } }))
    expect(res.status).toBe(101)
  })

  it('updates and deletes a session, broadcasting to two sockets', async () => {
    const db = createDb(env.DB)
    await ensureDefaultUser(db)
    const s = await createSession(db, { user_id: 1, title: 'old', provider_id: null, model_id: null })
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ type: 'session.update', session_id: s.id, title: 'new', system_prompt: 'sys' }))
    const ea = await a.next('session.updated')
    const eb = await b.next('session.updated')
    expect(ea).toMatchObject({ type: 'session.updated', session: { id: s.id, title: 'new', system_prompt: 'sys' } })
    expect(eb).toEqual(ea)
    b.ws.send(JSON.stringify({ type: 'session.delete', session_id: s.id }))
    expect(await a.next('session.deleted')).toEqual({ type: 'session.deleted', session_id: s.id })
  })

  it('answers invalid commands with an error event carrying request_id', async () => {
    const { ws, next, nextAfter } = await connect()
    ws.send(JSON.stringify({ type: 'session.update', request_id: 'r9' }))
    const err = await next('error')
    expect(err).toMatchObject({ type: 'error', request_id: 'r9', message: 'invalid command' })
    ws.send('not json')
    expect(await nextAfter('error', 2)).toEqual({ type: 'error', message: 'malformed json' })
  })

  it('auto-answers the ping keepalive without waking handleCommand', async () => {
    const { ws, raw, events } = await connect()
    ws.send('ping')
    const deadline = Date.now() + 2000
    while (raw.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(raw).toEqual(['pong'])
    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('stop() only resolves once the aborted job untracks itself', async () => {
    await runInDurableObject(env.USER_HUB.getByName('stop-test'), async (instance: UserHub) => {
      const hub = instance.app.hub
      const message: Message = {
        id: 4242, session_id: 99, parent_id: null, seq: 1, role: 'assistant', parts: [],
        provider_id: null, model_id: null, usage: null, status: 'streaming', error: null, created_at: 0,
      }
      const job = { message, sessionId: 99, controller: new AbortController(), startedAt: Date.now(), parts: [] }
      await hub.trackInflight(job)

      let settled = false
      const stopped = hub.stop(99).then(() => { settled = true })
      await new Promise((r) => setTimeout(r, 20))
      expect(job.controller.signal.aborted).toBe(true)
      expect(settled).toBe(false)

      await hub.untrackInflight(message.id)
      await stopped
      expect(settled).toBe(true)
      expect(hub.inflight()).toEqual([])
    })
  })

  it('updates settings and broadcasts them', async () => {
    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'settings.update', settings: { plugins: { demo: true } } }))
    expect(await next('settings.updated')).toEqual({ type: 'settings.updated', settings: { plugins: { demo: true } } })
  })
})
