import { Context, Service } from 'cordis'
import { createCodexClient } from './client'
import { CodexCredentialStore, type CodexCredentialSnapshot } from './credentials'
import { CodexOAuthFlowStore } from './flow'
import { CodexProtocolError, type CodexTokenBundle } from './types'
import { CODEX_REFRESH_SKEW_MS } from './constants'
import { decryptJson } from '../llm/crypto'

type ConnectedCredentials = CodexCredentialSnapshot & { status: 'connected' }

export class CodexReconnectRequiredError extends Error {
  constructor(readonly providerId: number) {
    super('Codex reconnect required')
    this.name = 'CodexReconnectRequiredError'
  }
}

export type CodexOAuthPollResult =
  | { status: 'pending'; next_poll_at: number }
  | { status: 'complete'; providerId: number; initialConnection: boolean; modelIds: string[]; modelListError: string | null }
  | { status: 'failed'; error: string }

export type CodexDisconnectResult = { status: 'disconnected'; revision: number } | { status: 'not-found' } | { status: 'conflict' }

const missingFlow = (): CodexOAuthPollResult => ({ status: 'failed', error: 'Codex authorization expired or was cancelled' })
const credentialErrors = new Set([
  'This Codex account already has a provider', 'Reconnect must use the same Codex account',
  'Codex credentials changed concurrently; reload and retry', 'Codex provider not found',
])

type CodexLogLevel = 'info' | 'warn'

function logCodexEvent(level: CodexLogLevel, event: string, fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ event, ...fields }))
}

function protocolFailure(error: unknown): { category: string; status: number | null } {
  return error instanceof CodexProtocolError
    ? { category: error.category, status: error.status, ...error.diagnostics }
    : { category: 'application', status: null }
}

async function requestWithDeadline<T>(request: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal, expiresAt = Infinity): Promise<T> {
  const controller = new AbortController()
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal
  const timeoutMs = Math.max(0, Math.min(30_000, expiresAt - Date.now()))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    if (timeoutMs === 0) controller.abort()
    signal.throwIfAborted()
    return await request(signal)
  } finally {
    clearTimeout(timer)
  }
}

export class Codex extends Service {
  static readonly provide = 'codex'
  static readonly inject = ['env', 'db', 'doState']

  readonly client = createCodexClient((input, init) => fetch(input, init))
  readonly credentials: CodexCredentialStore
  readonly flows: CodexOAuthFlowStore
  private readonly polling = new Map<string, AbortController>()
  private readonly refreshing = new Map<number, Promise<ConnectedCredentials>>()

  constructor(ctx: Context) {
    super(ctx, 'codex')
    this.credentials = new CodexCredentialStore(ctx.db.orm, ctx.env.KEY_ENCRYPTION_SECRET)
    this.flows = new CodexOAuthFlowStore(ctx.doState.storage, ctx.env.KEY_ENCRYPTION_SECRET)
  }

  private async readConnected(providerId: number): Promise<ConnectedCredentials> {
    const current = await this.credentials.read(providerId)
    if (!current || current.status !== 'connected') throw new CodexReconnectRequiredError(providerId)
    return current as ConnectedCredentials
  }

  async getValidCredentials(providerId: number, forceRefresh = false): Promise<ConnectedCredentials> {
    const current = await this.readConnected(providerId)
    if (!forceRefresh && current.bundle.expiresAt > Date.now() + CODEX_REFRESH_SKEW_MS) return current
    return this.refreshOnce(current)
  }

  private refreshOnce(snapshot: ConnectedCredentials): Promise<ConnectedCredentials> {
    const pending = this.refreshing.get(snapshot.providerId)
    if (pending) return pending
    const refresh = (async () => {
      const startedAt = performance.now()
      const current = await this.readConnected(snapshot.providerId)
      if (current.revision !== snapshot.revision || current.encryptedBundle !== snapshot.encryptedBundle) return current
      try {
        const bundle = await requestWithDeadline(signal => this.client.refreshTokens(current.bundle, signal))
        await this.credentials.storeRefresh(current, bundle, Date.now())
      } catch (error) {
        logCodexEvent('warn', 'codex.token_refresh.failed', {
          providerId: current.providerId, operation: 'token refresh', credentialRevision: current.revision,
          ...protocolFailure(error), durationMs: Math.max(0, performance.now() - startedAt),
        })
        if (!(error instanceof CodexProtocolError) || error.category !== 'permanent') throw error
        const message = new CodexProtocolError('token refresh', 'permanent', error.status).message
        if (await this.credentials.markReconnectRequired(current, message, Date.now())) throw new CodexReconnectRequiredError(current.providerId)
      }
      // A stale CAS belongs to a newer rotation, reconnect, or disconnect. Never return stale tokens.
      const refreshed = await this.readConnected(snapshot.providerId)
      logCodexEvent('info', 'codex.token_refresh.succeeded', {
        providerId: current.providerId, operation: 'token refresh', previousRevision: current.revision,
        credentialRevision: refreshed.revision, durationMs: Math.max(0, performance.now() - startedAt),
      })
      return refreshed
    })().finally(() => { this.refreshing.delete(snapshot.providerId) })
    this.refreshing.set(snapshot.providerId, refresh)
    return refresh
  }

  async listModels(providerId: number): Promise<string[]> {
    const startedAt = performance.now()
    let credentialRevision: number | null = null
    try {
      const current = await this.getValidCredentials(providerId)
      credentialRevision = current.revision
      const models = await requestWithDeadline(signal => this.client.listModels(current.bundle, signal))
      logCodexEvent('info', 'codex.model_list.succeeded', {
        providerId, operation: 'model listing', credentialRevision,
        modelCount: models.length, durationMs: Math.max(0, performance.now() - startedAt),
      })
      return models
    } catch (error) {
      logCodexEvent('warn', 'codex.model_list.failed', {
        providerId, operation: 'model listing', credentialRevision,
        ...protocolFailure(error), durationMs: Math.max(0, performance.now() - startedAt),
      })
      throw error
    }
  }

  async start(providerId?: number) {
    const startedAt = performance.now()
    try {
      const snapshot = providerId === undefined ? null : await this.credentials.read(providerId)
      if (providerId !== undefined && !snapshot) throw new Error('Codex provider not found')
      const grant = await requestWithDeadline(signal => this.client.requestDeviceCode(signal))
      const flow = await this.flows.create({
        ...grant, flowId: crypto.randomUUID(), nextPollAt: Date.now(),
        ...(snapshot ? { reconnect: { providerId: snapshot.providerId, revision: snapshot.revision } } : {}),
      })
      logCodexEvent('info', 'codex.oauth_start.succeeded', {
        providerId: providerId ?? null, operation: 'device code request', reconnect: snapshot !== null,
        durationMs: Math.max(0, performance.now() - startedAt),
      })
      return flow
    } catch (error) {
      logCodexEvent('warn', 'codex.oauth_start.failed', {
        providerId: providerId ?? null, operation: 'device code request', reconnect: providerId !== undefined,
        ...protocolFailure(error), durationMs: Math.max(0, performance.now() - startedAt),
      })
      throw error
    }
  }

  async poll(flowId: string): Promise<CodexOAuthPollResult> {
    if (this.polling.has(flowId)) {
      const flow = await this.flows.read(flowId, Date.now())
      return flow ? { status: 'pending', next_poll_at: flow.nextPollAt } : missingFlow()
    }
    const controller = new AbortController()
    const startedAt = performance.now()
    this.polling.set(flowId, controller)
    try {
      const now = Date.now()
      const flow = await this.flows.read(flowId, now)
      if (!flow || controller.signal.aborted) return missingFlow()
      if (now < flow.nextPollAt) return { status: 'pending', next_poll_at: flow.nextPollAt }
      flow.nextPollAt = now + flow.intervalMs
      await this.flows.update(flow)
      if (controller.signal.aborted) return missingFlow()
      const authorization = await requestWithDeadline(
        signal => this.client.pollDeviceCode(flow.deviceAuthId, flow.userCode, signal), controller.signal, flow.expiresAt,
      )
      if (controller.signal.aborted || !await this.flows.read(flowId, Date.now())) return missingFlow()
      if (authorization.status === 'pending') return { status: 'pending', next_poll_at: flow.nextPollAt }
      const bundle = await requestWithDeadline(signal => this.client.exchangeDeviceCode(authorization, signal), controller.signal, flow.expiresAt)
      if (controller.signal.aborted || !await this.flows.read(flowId, Date.now())) return missingFlow()
      // Deletion claims completion against cancellation before the D1 credential transaction.
      if (!await this.flows.delete(flowId)) return missingFlow()
      let providerId: number
      if (flow.reconnect) {
        providerId = flow.reconnect.providerId
        await this.credentials.reconnect(providerId, flow.reconnect.revision, bundle, Date.now())
      } else {
        providerId = await this.credentials.createProvider(bundle, Date.now())
      }
      try {
        const modelIds = await this.listModels(providerId)
        logCodexEvent('info', 'codex.oauth_complete.succeeded', {
          providerId, operation: 'authorization completion', initialConnection: !flow.reconnect,
          modelCount: modelIds.length, modelListFailed: false, durationMs: Math.max(0, performance.now() - startedAt),
        })
        return { status: 'complete', providerId, initialConnection: !flow.reconnect, modelIds, modelListError: null }
      } catch (error) {
        logCodexEvent('info', 'codex.oauth_complete.succeeded', {
          providerId, operation: 'authorization completion', initialConnection: !flow.reconnect,
          modelCount: 0, modelListFailed: true, durationMs: Math.max(0, performance.now() - startedAt),
        })
        return { status: 'complete', providerId, initialConnection: !flow.reconnect, modelIds: [], modelListError: error instanceof CodexProtocolError ? error.message : 'Codex model listing failed' }
      }
    } catch (error) {
      await this.flows.delete(flowId)
      logCodexEvent('warn', 'codex.oauth_complete.failed', {
        operation: 'authorization completion', ...protocolFailure(error),
        durationMs: Math.max(0, performance.now() - startedAt),
      })
      return {
        status: 'failed', error: error instanceof CodexProtocolError ? error.message
          : error instanceof Error && credentialErrors.has(error.message) ? error.message : 'Codex authorization failed',
      }
    } finally {
      this.polling.delete(flowId)
    }
  }

  async cancel(flowId: string): Promise<void> {
    this.polling.get(flowId)?.abort()
    await this.flows.delete(flowId)
  }

  async disconnect(providerId: number): Promise<CodexDisconnectResult> {
    const startedAt = performance.now()
    try {
      const current = await this.credentials.readForDisconnect(providerId)
      if (!current) return { status: 'not-found' }
      if (current.status === 'disconnected') return { status: 'disconnected', revision: current.revision }
      const revokeStartedAt = performance.now()
      try {
        // Unreadable credentials must still be locally removable with the captured CAS guard.
        const bundle = await decryptJson<CodexTokenBundle>(this.ctx.env.KEY_ENCRYPTION_SECRET, current.encryptedBundle!)
        await requestWithDeadline(signal => this.client.revoke(bundle.refreshToken, signal))
        logCodexEvent('info', 'codex.token_revoke.succeeded', {
          providerId, operation: 'token revoke', credentialRevision: current.revision,
          durationMs: Math.max(0, performance.now() - revokeStartedAt),
        })
      } catch (error) {
        logCodexEvent('warn', 'codex.token_revoke.failed', {
          providerId, operation: 'token revoke', credentialRevision: current.revision,
          ...protocolFailure(error), durationMs: Math.max(0, performance.now() - revokeStartedAt),
        })
      }
      // Revocation belongs to the captured connection. Never clear a newer reconnect or rotation.
      if (await this.credentials.disconnect(providerId, current.revision, Date.now(), current.encryptedBundle)) {
        logCodexEvent('info', 'codex.disconnect.succeeded', {
          providerId, operation: 'disconnect', credentialRevision: current.revision,
          durationMs: Math.max(0, performance.now() - startedAt),
        })
        return { status: 'disconnected', revision: current.revision + 1 }
      }
      const latest = await this.credentials.readForDisconnect(providerId)
      if (!latest) return { status: 'not-found' }
      return latest.status === 'disconnected' ? { status: 'disconnected', revision: latest.revision } : { status: 'conflict' }
    } catch { throw new Error('Codex disconnect failed') }
  }
}

export const CodexPlugin = Codex
