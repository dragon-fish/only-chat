import { Context, Service } from 'cordis'
import { createCodexClient } from './client'
import { CodexCredentialStore } from './credentials'
import { CodexOAuthFlowStore } from './flow'
import { CodexProtocolError } from './types'

export type CodexOAuthPollResult =
  | { status: 'pending'; next_poll_at: number }
  | { status: 'complete'; providerId: number; modelIds: string[]; modelListError: string | null }
  | { status: 'failed'; error: string }

const missingFlow = (): CodexOAuthPollResult => ({ status: 'failed', error: 'Codex authorization expired or was cancelled' })
const credentialErrors = new Set([
  'This Codex account already has a provider', 'Reconnect must use the same Codex account',
  'Codex credentials changed concurrently; reload and retry', 'Codex provider not found',
])

export class Codex extends Service {
  static readonly provide = 'codex'
  static readonly inject = ['env', 'db', 'doState']

  readonly client = createCodexClient((input, init) => fetch(input, init))
  readonly credentials: CodexCredentialStore
  readonly flows: CodexOAuthFlowStore
  private readonly polling = new Map<string, AbortController>()

  constructor(ctx: Context) {
    super(ctx, 'codex')
    this.credentials = new CodexCredentialStore(ctx.db.orm, ctx.env.KEY_ENCRYPTION_SECRET)
    this.flows = new CodexOAuthFlowStore(ctx.doState.storage, ctx.env.KEY_ENCRYPTION_SECRET)
  }

  async start(providerId?: number) {
    const snapshot = providerId === undefined ? null : await this.credentials.read(providerId)
    if (providerId !== undefined && !snapshot) throw new Error('Codex provider not found')
    const grant = await this.client.requestDeviceCode()
    return this.flows.create({
      ...grant, flowId: crypto.randomUUID(), nextPollAt: Date.now(),
      ...(snapshot ? { reconnect: { providerId: snapshot.providerId, revision: snapshot.revision } } : {}),
    })
  }

  async poll(flowId: string): Promise<CodexOAuthPollResult> {
    if (this.polling.has(flowId)) {
      const flow = await this.flows.read(flowId, Date.now())
      return flow ? { status: 'pending', next_poll_at: flow.nextPollAt } : missingFlow()
    }
    const controller = new AbortController()
    this.polling.set(flowId, controller)
    try {
      const now = Date.now()
      const flow = await this.flows.read(flowId, now)
      if (!flow || controller.signal.aborted) return missingFlow()
      if (now < flow.nextPollAt) return { status: 'pending', next_poll_at: flow.nextPollAt }
      flow.nextPollAt = now + flow.intervalMs
      await this.flows.update(flow)
      if (controller.signal.aborted) return missingFlow()
      const authorization = await this.client.pollDeviceCode(flow.deviceAuthId, flow.userCode, controller.signal)
      if (controller.signal.aborted || !await this.flows.read(flowId, Date.now())) return missingFlow()
      if (authorization.status === 'pending') return { status: 'pending', next_poll_at: flow.nextPollAt }
      const bundle = await this.client.exchangeDeviceCode(authorization, controller.signal)
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
        const modelIds = await this.client.listModels(bundle)
        return { status: 'complete', providerId, modelIds, modelListError: null }
      } catch (error) {
        return { status: 'complete', providerId, modelIds: [], modelListError: error instanceof CodexProtocolError ? error.message : 'Codex model listing failed' }
      }
    } catch (error) {
      await this.flows.delete(flowId)
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
}

export const CodexPlugin = Codex
