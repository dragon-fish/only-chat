import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserHub } from '@/server/index'
import * as hubIdentity from '@/server/plugins/hub/identity'
import { login, registerAndLogin } from './auth-helper'
import { connect } from './ws-helper'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function socketPair() {
  const first = await registerAndLogin()
  const second = await login()
  const firstIdentity = await (await first.request('/api/auth/get-session')).json() as { session: { id: string } }
  const sockets = await Promise.all([connect(first), connect(second)])
  await Promise.all(sockets.map(socket => socket.next('snapshot')))
  return { sockets, firstAuthSessionId: firstIdentity.session.id }
}

const older = { type: 'settings.updated' as const, settings: { plugins: { enabled: false } } }
const newer = { type: 'settings.updated' as const, settings: { plugins: { enabled: true } } }

beforeEach(async () => {
  await env.DB.exec("DELETE FROM users; DELETE FROM sqlite_sequence WHERE name = 'users'; DELETE FROM site_settings")
})
afterEach(async () => {
  vi.restoreAllMocks()
  await runInDurableObject(env.USER_HUB.getByName('1'), (_instance: UserHub, state) => {
    for (const socket of state.getWebSockets()) socket.close(1000)
  })
})

describe('Hub broadcast ordering', () => {
  it('delivers concurrent producer events in one order to every recipient', async () => {
    const { sockets, firstAuthSessionId } = await socketPair()
    const finishedWhileOlderBlocked = await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub, state) => {
      const hub = instance.app.hub
      const recipients = state.getWebSockets().sort((a, b) => {
        const first = (socket: WebSocket) => (socket.deserializeAttachment() as hubIdentity.SocketAttachment).authSessionId === firstAuthSessionId
        return Number(first(b)) - Number(first(a))
      })
      const enumerate = vi.spyOn(state, 'getWebSockets').mockReturnValue(recipients)
      const blocked = deferred()
      const release = deferred()
      let validations = 0
      // Only substitute D1 completion timing; use real Hub producers and real recipient sockets.
      const validate = vi.spyOn(hubIdentity, 'hasActiveAuthSession').mockImplementation(async () => {
        if (++validations === 2) {
          blocked.resolve()
          await release.promise
        }
        return true
      })
      const first = hub.broadcast(older)
      await blocked.promise
      let secondFinished = false
      const second = hub.broadcast(newer).then(() => { secondFinished = true })
      try {
        // Drain ready promise jobs while only older's second recipient remains gated.
        await new Promise(resolve => setTimeout(resolve, 0))
        const finishedWhileOlderBlocked = secondFinished
        release.resolve()
        await Promise.all([first, second])
        return finishedWhileOlderBlocked
      } finally {
        release.resolve()
        await Promise.allSettled([first, second])
        validate.mockRestore()
        enumerate.mockRestore()
      }
    })
    await Promise.all(sockets.map(socket => socket.nextAfter('settings.updated', 2)))
    expect(sockets.map(socket => socket.events.filter(event => event.type === 'settings.updated'))).toEqual([
      [older, newer], [older, newer],
    ])
    expect(finishedWhileOlderBlocked).toBe(false)
  })

  it.each(['validation', 'send'] as const)('continues delivering after a recipient %s fails', async failure => {
    const { sockets } = await socketPair()
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub, state) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const fail = failure === 'validation'
        ? vi.spyOn(hubIdentity, 'hasActiveAuthSession').mockRejectedValueOnce(new Error('synthetic validation failure'))
        : vi.spyOn(state.getWebSockets()[0]!, 'send').mockImplementationOnce(() => { throw new Error('synthetic send failure') })
      try { await Promise.all([instance.app.hub.broadcast(older), instance.app.hub.broadcast(newer)]) }
      finally { fail.mockRestore(); warning.mockRestore() }
    })
    const healthy = sockets.find(socket => socket.ws.readyState !== WebSocket.CLOSED)!
    await healthy.nextAfter('settings.updated', 2)
    expect(healthy.events.filter(event => event.type === 'settings.updated')).toEqual([older, newer])
  })

  it('rejects a failed broadcast to its caller without poisoning the following broadcast', async () => {
    const { sockets } = await socketPair()
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub, state) => {
      const enumerate = vi.spyOn(state, 'getWebSockets').mockImplementationOnce(() => { throw new Error('synthetic enumeration failure') })
      try {
        const results = await Promise.allSettled([instance.app.hub.broadcast(older), instance.app.hub.broadcast(newer)])
        expect(results[0]).toMatchObject({ status: 'rejected', reason: { message: 'synthetic enumeration failure' } })
        expect(results[1]).toEqual({ status: 'fulfilled', value: undefined })
      } finally { enumerate.mockRestore() }
    })
    await Promise.all(sockets.map(socket => socket.next('settings.updated')))
    expect(sockets.map(socket => socket.events.filter(event => event.type === 'settings.updated'))).toEqual([[newer], [newer]])
  })

  it('lets a revoked generation finalize behind an already queued broadcast', async () => {
    const { sockets } = await socketPair()
    await runInDurableObject(env.USER_HUB.getByName('1'), async (instance: UserHub) => {
      const hub = instance.app.hub
      const blocked = deferred()
      const release = deferred()
      const validate = vi.spyOn(hubIdentity, 'hasActiveAuthSession').mockImplementationOnce(async () => {
        blocked.resolve()
        await release.promise
        return true
      })
      const message = { id: 9001, conversation_id: 100, parent_id: null, seq: 1, role: 'assistant' as const, parts: [], provider_id: null, model_id: null, usage: null, status: 'streaming' as const, error: null, created_at: 0 }
      const job = { message, conversationId: 100, controller: new AbortController(), startedAt: Date.now(), parts: [], stash: [] }
      await hub.trackInflight(job)
      const sending = hub.broadcast(older)
      await blocked.promise
      const revoking = hub.revokeAccess()
      expect(job.controller.signal.aborted).toBe(true)
      const finalizing = hub.broadcast({ type: 'message.done', message_id: message.id, status: 'aborted', usage: null, error: null })
        .finally(() => hub.untrackInflight(message.id))
      try {
        release.resolve()
        await revoking
        expect(hub.inflight()).toEqual([])
        await Promise.all([sending, finalizing])
      } finally { release.resolve(); validate.mockRestore() }
    })
    expect(sockets.map(socket => socket.events.map(event => event.type))).toEqual([['snapshot'], ['snapshot']])
  })
})
