import type { CodexOAuthStartResponse } from '@/shared/api'
import { decryptJson, encryptJson } from '../llm/crypto'
import type { CodexDeviceGrant } from './types'

export interface CodexPendingFlow extends CodexDeviceGrant {
  flowId: string
  nextPollAt: number
  reconnect?: { providerId: number; revision: number }
}

export class CodexOAuthFlowStore {
  constructor(readonly storage: DurableObjectStorage, readonly encryptionSecret: string) {}

  async create(input: CodexPendingFlow): Promise<CodexOAuthStartResponse> {
    await this.storage.put(`codex-oauth:${input.flowId}`, await encryptJson(this.encryptionSecret, input))
    return {
      flow_id: input.flowId, verification_url: input.verificationUrl, user_code: input.userCode,
      expires_at: input.expiresAt, poll_interval_ms: input.intervalMs,
    }
  }

  async read(flowId: string, now: number): Promise<CodexPendingFlow | null> {
    const encrypted = await this.storage.get<string>(`codex-oauth:${flowId}`)
    if (!encrypted) return null
    const flow = await decryptJson<CodexPendingFlow>(this.encryptionSecret, encrypted)
    if (flow.expiresAt <= now) {
      await this.delete(flowId)
      return null
    }
    return flow
  }

  async update(flow: CodexPendingFlow): Promise<void> {
    const encrypted = await encryptJson(this.encryptionSecret, flow)
    const key = `codex-oauth:${flow.flowId}`
    // Encryption yields to cancellation. Never recreate a flow deleted while encrypting.
    await this.storage.transaction(async tx => {
      if (await tx.get(key) !== undefined) await tx.put(key, encrypted)
    })
  }

  delete(flowId: string): Promise<boolean> {
    return this.storage.delete(`codex-oauth:${flowId}`)
  }
}
