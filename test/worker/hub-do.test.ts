import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import type { UserHub } from '@/server/index'
import { seedTestUser } from './user-fixture'
import { createConversation } from '@/server/plugins/hub/conversations'
import type { Message } from '@/shared/models'
import { connect } from './ws-helper'

describe('UserHub DO', () => {
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

  it('updates and deletes a conversation, broadcasting to two sockets', async () => {
    const db = createDb(env.DB)
    await seedTestUser(db)
    const s = await createConversation(db, { user_id: 1, title: 'old', provider_id: null, model_id: null })
    const a = await connect()
    const b = await connect()
    a.ws.send(JSON.stringify({ type: 'conversation.update', conversation_id: s.id, title: 'new', system_prompt: 'sys' }))
    const ea = await a.next('conversation.updated')
    const eb = await b.next('conversation.updated')
    expect(ea).toMatchObject({ type: 'conversation.updated', conversation: { id: s.id, title: 'new', system_prompt: 'sys' } })
    expect(eb).toEqual(ea)
    b.ws.send(JSON.stringify({ type: 'conversation.delete', conversation_id: s.id }))
    expect(await a.next('conversation.deleted')).toEqual({ type: 'conversation.deleted', conversation_id: s.id })
  })

  it('answers invalid commands with an error event carrying request_id', async () => {
    const { ws, next, nextAfter } = await connect()
    ws.send(JSON.stringify({ type: 'conversation.update', request_id: 'r9' }))
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
        id: 4242, conversation_id: 99, parent_id: null, seq: 1, role: 'assistant', parts: [],
        provider_id: null, model_id: null, usage: null, status: 'streaming', error: null, created_at: 0,
      }
      const job = { message, conversationId: 99, controller: new AbortController(), startedAt: Date.now(), parts: [] }
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
