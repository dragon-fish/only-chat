import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '@/server/db/client'
import { ensureDefaultUser } from '@/server/plugins/database'
import { createSession } from '@/server/plugins/hub/sessions'
import { connect } from './ws-helper'

describe('UserHub DO', () => {
  it('sends a snapshot on connect and rejects non-upgrade requests', async () => {
    const plain = await exports.default.fetch(new Request('https://x/ws'))
    expect(plain.status).toBe(426)
    const { next } = await connect()
    const snap = await next('snapshot')
    expect(snap).toEqual({ type: 'snapshot', inflight: [] })
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
    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'session.update', request_id: 'r9' }))
    const err = await next('error')
    expect(err).toMatchObject({ type: 'error', request_id: 'r9' })
    ws.send('not json')
    expect((await next('error')).type).toBe('error')
  })

  it('updates settings and broadcasts them', async () => {
    const { ws, next } = await connect()
    ws.send(JSON.stringify({ type: 'settings.update', settings: { plugins: { demo: true } } }))
    expect(await next('settings.updated')).toEqual({ type: 'settings.updated', settings: { plugins: { demo: true } } })
  })
})
