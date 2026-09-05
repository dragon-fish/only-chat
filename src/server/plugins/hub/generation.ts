import type { Hub } from './index'
import type { Message } from '@/shared/models'
import type { SendCommand, WsCommand } from '@/shared/ws'

/** Payload of the `message/before-send` event: feature plugins may inspect or amend the prompt. */
export interface BeforeSendPayload {
  sessionId: number
  systemPrompt: string | null
  path: Message[]
}

export async function runSend(_hub: Hub, _cmd: SendCommand): Promise<void> {
  throw new Error('not implemented')
}

export async function runRegenerate(_hub: Hub, _cmd: Extract<WsCommand, { type: 'regenerate' }>): Promise<void> {
  throw new Error('not implemented')
}

export async function runEdit(_hub: Hub, _cmd: Extract<WsCommand, { type: 'edit' }>): Promise<void> {
  throw new Error('not implemented')
}
